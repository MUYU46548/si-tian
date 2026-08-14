/**
 * add-place-type-frontmatter.js — 为场景地点批量补 `地点类型` frontmatter 字段（第二维度）
 *
 * 用法:
 *   node scripts/add-place-type-frontmatter.js --dry   # 只输出建议表
 *   node scripts/add-place-type-frontmatter.js          # 写入 frontmatter
 *
 * 分类: 自然/宗教/皇室/商业/工业/居住/公共/特殊
 * 优先级: 名称关键词 > tags > 兜底公共
 * 人工修正表（规则无法正确推断的文件）: OVERRIDES
 */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const LOCATIONS_PATH = 'E:/图书馆/ROSA/03 设定/02 场景地点';
const DRY = process.argv.includes('--dry');

// 名称关键词 → 地点类型（最长优先匹配）
const NAME_RULES = [
  { kw: '封印', type: '特殊' },
  { kw: '移动设施', type: '特殊' },
  { kw: '中立区', type: '特殊' },
  { kw: '飞船', type: '特殊' },
  { kw: '战舰', type: '特殊' },
  { kw: '若空之境', type: '特殊' },
  { kw: '遗迹', type: '特殊' },
  { kw: '神殿', type: '宗教' },
  { kw: '祭坛', type: '宗教' },
  { kw: '神社', type: '宗教' },
  { kw: '大社', type: '宗教' },
  { kw: '寺庙', type: '宗教' },
  { kw: '供奉', type: '宗教' },
  { kw: '神宫', type: '宗教' },
  { kw: '城堡', type: '皇室' },
  { kw: '府邸', type: '皇室' },
  { kw: '皇宫', type: '皇室' },
  { kw: '夏宫', type: '皇室' },
  { kw: '宫', type: '皇室' },
  { kw: '府', type: '皇室' },
  { kw: '堡', type: '皇室' },
  { kw: '酒楼', type: '商业' },
  { kw: '道具店', type: '商业' },
  { kw: '超市', type: '商业' },
  { kw: '餐厅', type: '商业' },
  { kw: '咖啡厅', type: '商业' },
  { kw: '咖啡屋', type: '商业' },
  { kw: '食堂', type: '商业' },
  { kw: '烘焙', type: '商业' },
  { kw: '面包店', type: '商业' },
  { kw: '店', type: '商业' },
  { kw: '工厂', type: '工业' },
  { kw: '日化厂', type: '工业' },
  { kw: '军械库', type: '工业' },
  { kw: '厂', type: '工业' },
  { kw: '住所', type: '居住' },
  { kw: '的家', type: '居住' },
  { kw: '庇护所', type: '居住' },
  { kw: '小屋', type: '居住' },
  { kw: '居住站', type: '居住' },
  { kw: '山', type: '自然' },
  { kw: '江', type: '自然' },
  { kw: '河', type: '自然' },
  { kw: '湖', type: '自然' },
  { kw: '谷', type: '自然' },
  { kw: '林', type: '自然' },
  { kw: '原', type: '自然' },
  { kw: '海', type: '自然' },
];

// tags → 地点类型（含关键词匹配）
const TAG_RULES = [
  { kw: '祭坛', type: '宗教' },
  { kw: '神殿', type: '宗教' },
  { kw: '神社', type: '宗教' },
  { kw: '大社', type: '宗教' },
  { kw: '寺庙', type: '宗教' },
  { kw: '供奉', type: '宗教' },
  { kw: '宫殿', type: '皇室' },
  { kw: '皇宫', type: '皇室' },
  { kw: '城堡', type: '皇室' },
  { kw: '酒楼', type: '商业' },
  { kw: '餐厅', type: '商业' },
  { kw: '咖啡厅', type: '商业' },
  { kw: '超市', type: '商业' },
  { kw: '面包店', type: '商业' },
  { kw: '食堂', type: '商业' },
  { kw: '工厂', type: '工业' },
  { kw: '军械库', type: '工业' },
  { kw: '住所', type: '居住' },
  { kw: '庇护所', type: '居住' },
  { kw: '小屋', type: '居住' },
  { kw: '地下室', type: '特殊' },
  { kw: '地宫', type: '特殊' },
  { kw: '遗迹', type: '特殊' },
  { kw: '飞船', type: '特殊' },
  { kw: '战舰', type: '特殊' },
  { kw: '移动设施', type: '特殊' },
  { kw: '里世界', type: '特殊' },
  { kw: '中立区', type: '特殊' },
  { kw: '传送门', type: '特殊' },
  { kw: '防空洞', type: '公共' },
];

// 人工修正（规则推断有误的文件名 → 正确类型）
const OVERRIDES = {
  '风神府': '居住',          // tags 小屋
  '雨神宫': '宗教',          // 神宫（神祇居所）优先于 宫→皇室
  '尼特加的花园': '公共',     // 花园 → 休闲公共设施
  '凤凰同盟临时据点': '特殊',  // 军事临时据点
  '绒花宫地下室': '特殊',     // 地宫
  '边境临时居住站': '居住',   // 居住站
  '蓝箭台': '工业',          // 军械库
  '墓园': '公共',            // 市政殡葬设施
  '海底墓场': '公共',
  '纷花号': '特殊',          // 飞船/移动设施
  '有求必应厅': '公共',       // 绒花宫内部大厅
  '智能体学校': '公共',       // 学校（tags 含"智能体庇护所"误伤）
  '记忆图书馆': '公共',       // 图书馆（tags 含"地下室"误伤）
  '特拉图雅中学地下防空洞': '公共', // 防空洞（tags 含"地下室"误伤）
  '庆云岛': '自然',          // 岛屿自然地貌
};

function classify(frontmatter, fileName) {
  const names = [fileName, frontmatter['名称'], frontmatter['别名']]
    .filter(Boolean)
    .flatMap(v => Array.isArray(v) ? v : [String(v)]);

  // 1. 人工修正
  if (OVERRIDES[fileName]) return { type: OVERRIDES[fileName], reason: '人工修正' };

  // 2. 名称关键词（最长优先）
  const sortedNames = [...NAME_RULES].sort((a, b) => b.kw.length - a.kw.length);
  for (const name of names) {
    for (const rule of sortedNames) {
      if (name.includes(rule.kw)) return { type: rule.type, reason: `名称含"${rule.kw}"` };
    }
  }

  // 3. tags 关键词
  const tags = Array.isArray(frontmatter['tags']) ? frontmatter['tags'] : [];
  for (const tag of tags) {
    for (const rule of TAG_RULES) {
      if (tag.includes(rule.kw) && rule.kw.length >= 2) return { type: rule.type, reason: `tags含"${rule.kw}"` };
    }
  }

  return { type: '公共', reason: '兜底' };
}

function collectFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  }
  walk(LOCATIONS_PATH);
  return files.sort();
}

function insertAfterLayer(raw, type) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx === -1) return null;
  // 插入到 `层级:` 行之后（若存在），否则 frontmatter 末尾
  let insertAt = -1;
  for (let i = 1; i < closeIdx; i++) {
    if (lines[i].startsWith('层级:')) { insertAt = i + 1; break; }
  }
  if (insertAt === -1) insertAt = closeIdx;
  lines.splice(insertAt, 0, `地点类型: ${type}`);
  return lines.join(eol);
}

function replaceOrInsert(raw, type) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx === -1) return null;
  for (let i = 1; i < closeIdx; i++) {
    if (lines[i].startsWith('地点类型:')) { lines[i] = `地点类型: ${type}`; return lines.join(eol); }
  }
  return insertAfterLayer(raw, type);
}

// ---- main ----
const files = collectFiles();
const results = [];
let skipped = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf-8');
  const { data: frontmatter, content } = matter(raw);
  const existing = frontmatter['地点类型'];
  const fileName = path.basename(file, '.md');
  // 聚落层级（城市/城镇/村庄）不标地点类型——它们有独立渲染样式
  if (['城市', '城镇', '村庄'].includes(frontmatter['层级'])) { skipped++; continue; }
  if (existing && !['自然', '宗教', '皇室', '商业', '工业', '居住', '公共', '特殊'].includes(existing)) {
    // 未知旧值 → 视为待重写
  } else if (existing) {
    skipped++;
    continue;
  }
  const { type, reason } = classify(frontmatter, fileName);
  results.push({ file, fileName, type, reason });
}

const byType = {};
for (const r of results) byType[r.type] = (byType[r.type] || 0) + 1;

console.log(`扫描 ${files.length} 个文件，跳过已有地点类型 ${skipped} 个，待处理 ${results.length} 个`);
console.log('分布:', JSON.stringify(byType));
console.log('---');
for (const r of results) console.log(`${r.type.padEnd(4)} ${r.fileName}  [${r.reason}]  ${path.relative(LOCATIONS_PATH, r.file).replace(/\\/g, '/')}`);

if (DRY) {
  console.log('\n[dry-run] 未写入任何文件');
} else {
  let written = 0;
  for (const r of results) {
    const raw = fs.readFileSync(r.file, 'utf-8');
    const { data: frontmatter } = matter(raw);
    const updated = frontmatter['地点类型'] ? replaceOrInsert(raw, r.type) : insertAfterLayer(raw, r.type);
    if (!updated) { console.error(`!! 无 frontmatter 块: ${r.file}`); continue; }
    fs.writeFileSync(r.file, updated, 'utf-8');
    written++;
  }
  console.log(`\n已写入 ${written} 个文件`);
}
