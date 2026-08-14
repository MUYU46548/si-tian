/**
 * add-layer-frontmatter.js — 为场景地点批量补 `层级` frontmatter 字段
 *
 * 用法:
 *   node scripts/add-layer-frontmatter.js --dry   # 只输出建议表，不写入
 *   node scripts/add-layer-frontmatter.js          # 写入 frontmatter
 *
 * 规则:
 *   - 仅处理 `03 设定/02 场景地点/` 下的 .md（排除 _ 开头）
 *   - 已有中文 `层级` 字段的文件跳过；已有英文值（facility 等）自动修正为中文
 *   - 分类优先级: 文件名/别名后缀 > tags > 正文"类别"字段 > 内容关键词 > 兜底 location
 *   - 写入值: 中文（城市/城镇/村庄/区域/设施/地点），与地理系统模板一致，由提取脚本映射为 layer 代码
 *   - 插入位置: `创建日期:` 行之后（与地理系统模板一致）; 无创建日期则插 frontmatter 末尾
 *   - 保持文件其余内容与换行符原样（纯文本行插入，不重新序列化 YAML）
 */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const LOCATIONS_PATH = 'E:/图书馆/ROSA/03 设定/02 场景地点';
const DRY = process.argv.includes('--dry');

const LAYER_ZH = { city: '城市', town: '城镇', village: '村庄', region: '区域', facility: '设施', location: '地点' };

// 与 extract-data.js 保持一致的分类规则（增强: 设施/封印地等）
const LAYER_SUFFIX_RULES = [
  { suffix: '城', layer: 'city' },
  { suffix: '镇', layer: 'town' },
  { suffix: '村', layer: 'village' },
  { suffix: '半岛', layer: 'region' },
  { suffix: '岛', layer: 'region' },
  { suffix: '流域', layer: 'region' },
  { suffix: '设施', layer: 'facility' },
  { suffix: '府', layer: 'facility' },
  { suffix: '宫', layer: 'facility' },
  { suffix: '殿', layer: 'facility' },
  { suffix: '馆', layer: 'facility' },
  { suffix: '院', layer: 'facility' },
  { suffix: '楼', layer: 'facility' },
  { suffix: '塔', layer: 'facility' },
  { suffix: '寺', layer: 'facility' },
  { suffix: '庙', layer: 'facility' },
  { suffix: '坛', layer: 'facility' },
  { suffix: '阁', layer: 'facility' },
  { suffix: '堂', layer: 'facility' },
  { suffix: '厅', layer: 'facility' },
  { suffix: '站', layer: 'facility' },
  { suffix: '厂', layer: 'facility' },
  { suffix: '店', layer: 'facility' },
  { suffix: '邸', layer: 'facility' },
  { suffix: '社', layer: 'facility' },
  { suffix: '室', layer: 'facility' },
  { suffix: '所', layer: 'facility' },
  { suffix: '库', layer: 'facility' },
  { suffix: '台', layer: 'facility' },
  { suffix: '中心', layer: 'facility' },
  { suffix: '基地', layer: 'facility' },
  { suffix: '据点', layer: 'facility' },
  { suffix: '墓', layer: 'facility' },
  { suffix: '桥', layer: 'facility' },
  { suffix: '山', layer: 'location' },
  { suffix: '江', layer: 'location' },
  { suffix: '河', layer: 'location' },
  { suffix: '湖', layer: 'location' },
  { suffix: '谷', layer: 'location' },
  { suffix: '林', layer: 'location' },
  { suffix: '原', layer: 'location' },
  { suffix: '海', layer: 'location' },
  { suffix: '滩', layer: 'location' },
  { suffix: '崖', layer: 'location' },
];

const TAG_LAYER_MAP = {
  '城市': 'city', '城邦': 'city', '首都': 'city',
  '城镇': 'town',
  '村庄': 'village', '村落': 'village',
  '岛屿': 'region', '海域': 'region',
  '建筑': 'facility', '宫殿': 'facility', '神殿': 'facility', '学校': 'facility',
  '医院': 'facility', '图书馆': 'facility', '咖啡厅': 'facility', '餐厅': 'facility',
  '超市': 'facility', '工厂': 'facility', '监狱': 'facility', '祭坛': 'facility',
  '广场': 'facility', '城堡': 'facility', '花园': 'facility',
  '空间站': 'facility', '飞船': 'facility', '战舰': 'facility',
  '地下室': 'facility', '地下铁路': 'facility', '遗迹': 'facility', '地宫': 'facility',
  '酒楼': 'facility', '面包店': 'facility', '广播站': 'facility', '传送门': 'facility',
  '工作室': 'facility', '钟楼': 'facility', '军械库': 'facility', '神社': 'facility',
  '墓园': 'facility', '墓场': 'facility', '庇护所': 'facility',
  '防空洞': 'facility', '地下防空洞': 'facility', '防空设施': 'facility',
  '湖泊': 'location', '山脉': 'location', '山': 'location', '森林': 'location',
};

function classify(frontmatter, content, fileName) {
  const names = [fileName, frontmatter['名称'], frontmatter['别名']]
    .filter(Boolean)
    .flatMap(v => Array.isArray(v) ? v : [String(v)]);
  if (!names.length && frontmatter.title) names.push(String(frontmatter.title));

  // 1. 文件名/别名后缀（最长优先）
  const sortedRules = [...LAYER_SUFFIX_RULES].sort((a, b) => b.suffix.length - a.suffix.length);
  for (const name of names) {
    for (const rule of sortedRules) {
      if (name.endsWith(rule.suffix)) return { layer: rule.layer, reason: `后缀"${rule.suffix}"` };
    }
  }

  // 2. tags 精确/包含匹配
  const tags = Array.isArray(frontmatter['tags']) ? frontmatter['tags'] : [];
  for (const tag of tags) {
    if (TAG_LAYER_MAP[tag]) return { layer: TAG_LAYER_MAP[tag], reason: `tags[${tag}]` };
  }
  for (const tag of tags) {
    for (const [key, layer] of Object.entries(TAG_LAYER_MAP)) {
      if (tag.includes(key) && key.length >= 2) return { layer, reason: `tags包含"${key}"` };
    }
  }

  // 3. 正文"类别"字段（列表项形式: - 类别：建筑）
  const catMatch = content.match(/类别[:：]\s*([^\n\r]+)/);
  if (catMatch) {
    const cat = catMatch[1];
    if (/城市|首都/.test(cat)) return { layer: 'city', reason: '类别-城市' };
    if (/城镇|镇/.test(cat)) return { layer: 'town', reason: '类别-城镇' };
    if (/村庄|村落/.test(cat)) return { layer: 'village', reason: '类别-村庄' };
    if (/建筑|设施|场所/.test(cat)) return { layer: 'facility', reason: '类别-建筑' };
    if (/区域/.test(cat)) return { layer: 'region', reason: '类别-区域' };
  }

  // 4. 内容关键词兜底
  if (/城市|首都/.test(content)) return { layer: 'city', reason: '内容-城市' };
  if (/城镇/.test(content)) return { layer: 'town', reason: '内容-城镇' };
  if (/村庄/.test(content)) return { layer: 'village', reason: '内容-村庄' };

  return { layer: 'location', reason: '兜底' };
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

function insertLayerLine(raw, layerZh) {
  // 检测换行符
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  // 定位 frontmatter 区间
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx === -1) return null;
  const insertLine = `层级: ${layerZh}`;
  let insertAt = -1;
  for (let i = 1; i < closeIdx; i++) {
    if (lines[i].startsWith('创建日期:')) { insertAt = i + 1; break; }
  }
  if (insertAt === -1) insertAt = closeIdx; // frontmatter 末尾
  lines.splice(insertAt, 0, insertLine);
  return lines.join(eol);
}

function replaceLayerValue(raw, layerZh) {
  // 已有英文层级值 → 原位替换为中文
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx === -1) return null;
  for (let i = 1; i < closeIdx; i++) {
    if (lines[i].startsWith('层级:')) { lines[i] = `层级: ${layerZh}`; break; }
  }
  return lines.join(eol);
}

// ---- main ----
const files = collectFiles();
const results = [];
let skipped = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf-8');
  const { data: frontmatter, content } = matter(raw);
  const existing = frontmatter['层级'];
  const fileName = path.basename(file, '.md');
  let layer, reason;
  if (existing && !LAYER_ZH[existing]) { skipped++; continue; } // 已是中文/未知 → 跳过
  if (existing && LAYER_ZH[existing]) { layer = existing; reason = '英→中修正'; }
  else { ({ layer, reason } = classify(frontmatter, content, fileName)); }
  results.push({ file, fileName, layer, reason });
}

const byLayer = {};
for (const r of results) byLayer[r.layer] = (byLayer[r.layer] || 0) + 1;

console.log(`扫描 ${files.length} 个文件，跳过已有层级 ${skipped} 个，待处理 ${results.length} 个`);
console.log('分布:', JSON.stringify(byLayer));
console.log('---');
for (const r of results) console.log(`${r.layer.padEnd(8)} ${r.fileName}  [${r.reason}]  ${path.relative(LOCATIONS_PATH, r.file).replace(/\\/g, '/')}`);

if (DRY) {
  console.log('\n[dry-run] 未写入任何文件');
} else {
  let written = 0;
  for (const r of results) {
    const raw = fs.readFileSync(r.file, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    const layerZh = LAYER_ZH[r.layer] || r.layer;
    let updated;
    if (frontmatter['层级']) updated = replaceLayerValue(raw, layerZh);
    else updated = insertLayerLine(raw, layerZh);
    if (!updated) { console.error(`!! 无 frontmatter 块: ${r.file}`); continue; }
    fs.writeFileSync(r.file, updated, 'utf-8');
    written++;
  }
  console.log(`\n已写入 ${written} 个文件`);
}
