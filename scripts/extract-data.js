const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// Vault 路径可配置化（2026-08-16）：模块级可变，extractGeodata(targetVault) 入口覆盖；
// CLI 支持 --vault 参数；主进程通过 require 传入配置的路径
const DEFAULT_VAULT = ''; // 留空：主进程调用时传入用户配置的路径，CLI 时通过 --vault 指定
let vaultPath = DEFAULT_VAULT;

function geoSystemPath() { return path.join(vaultPath, '03 设定', '11 地理系统'); }
function locationsPath() { return path.join(vaultPath, '03 设定', '02 场景地点'); }
function indexPath() { return path.join(vaultPath, '01 索引', '地理系统索引.md'); }

const LAYER_KEYWORDS = {
  '世界': 'world',
  '星系': 'galaxy',
  '星域': 'star_domain',
  '行星': 'planet',
  '恒星': 'star',
  '卫星': 'moon',
  '区域': 'region',
  '城镇': 'town',
  '城市': 'city',
  '村庄': 'village',
  '建筑': 'building',
  '设施': 'facility',
  '地点': 'location',
};

const LAYER_LABELS = {
  world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
  planet: '行星', moon: '卫星', region: '区域', city: '城市',
  town: '城镇', village: '村庄', building: '建筑', facility: '设施', location: '地点', unknown: '未知'
};

const LAYER_ORDER = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'building', 'facility', 'location', 'unknown'];

// ===== 增量提取缓存（批次C3） =====
// .sitian/extract-cache.json 按 mtimeMs+size 指纹缓存每个 Markdown 的解析产物
// （frontmatter/wikilinks/正文），未变更的文件跳过读盘与 gray-matter 解析。
// 该文件与 geodata.json 同级、同为编辑器元数据（可删可重建），绝不写回 Markdown。
const PARSE_CACHE_VERSION = 1;
const parseCache = {
  files: {},        // { [relativePath]: { fp: 'mtimeMs:size', parsed } }
  seen: new Set(),  // 本次扫描遇到的文件（用于清理已删除文件的缓存条目）
  hits: 0,
  misses: 0,
};

function parseCachePath() { return path.join(vaultPath, '.sitian', 'extract-cache.json'); }

function loadParseCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(parseCachePath(), 'utf-8'));
    if (raw.version !== PARSE_CACHE_VERSION || raw.vaultPath !== vaultPath) return;
    if (!raw.files || typeof raw.files !== 'object') return;
    parseCache.files = raw.files;
  } catch (e) { /* 缓存缺失/损坏 → 全量提取 */ }
}

function saveParseCache() {
  try {
    fs.mkdirSync(path.dirname(parseCachePath()), { recursive: true });
    fs.writeFileSync(parseCachePath(), JSON.stringify({
      version: PARSE_CACHE_VERSION,
      vaultPath,
      files: parseCache.files,
    }), 'utf-8');
  } catch (e) { console.warn('[提取] 写入解析缓存失败（不影响提取结果）:', e.message); }
}

function parseMdFile(filePath) {
  try {
    const relativePath = path.relative(vaultPath, filePath);
    parseCache.seen.add(relativePath);

    // 指纹命中 → 复用上次解析产物（浅拷贝防下游 mutation 污染缓存）
    let fp = null;
    try {
      const st = fs.statSync(filePath);
      fp = `${st.mtimeMs}:${st.size}`;
    } catch (e) { /* stat 失败 → 走全量读取 */ }
    const cached = fp ? parseCache.files[relativePath] : null;
    if (cached && cached.fp === fp) {
      parseCache.hits++;
      const fm = cached.parsed.frontmatter;
      return {
        frontmatter: { ...fm, tags: Array.isArray(fm.tags) ? [...fm.tags] : fm.tags },
        content: cached.parsed.content,
        wikilinks: [...cached.parsed.wikilinks],
        fileName: cached.parsed.fileName,
        relativePath,
      };
    }
    parseCache.misses++;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    const wikilinks = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) wikilinks.push(match[1].trim());
    const parsed = { frontmatter, content, wikilinks, fileName: path.basename(filePath, '.md') };
    if (fp) parseCache.files[relativePath] = { fp, parsed };
    return { ...parsed, relativePath };
  } catch (e) { console.error(`解析失败: ${filePath}`, e.message); return null; }
}

function scanGeoSystem() {
  const nodes = [];
  function scanDir(dir, parentLayer, depth = 0) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const layerName = detectLayer(entry.name);
        scanDir(fullPath, layerName || parentLayer, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const parsed = parseMdFile(fullPath);
        if (!parsed) continue;
        const id = normalizeId(parsed.fileName);
        let layer = parsed.frontmatter['层级'] || detectLayerFromPath(fullPath) || parentLayer || 'unknown';
        layer = LAYER_KEYWORDS[layer] || layer;
        const parentLink = parsed.frontmatter['上层区域'];
        let parentId = null;
        if (parentLink && parentLink !== '无') parentId = normalizeId(parentLink.replace(/\[\[|\]\]/g, '').trim());
        const tags = Array.isArray(parsed.frontmatter['tags']) ? parsed.frontmatter['tags'] : [];
        nodes.push({
          id, name: parsed.fileName, layer, layerLabel: LAYER_LABELS[layer] || layer,
          parentId, tags, sourcePath: parsed.relativePath, wikilinks: parsed.wikilinks,
          placeType: parsed.frontmatter['地点类型'] || null,
          coordinate: { x: null, y: null },
        });
      }
    }
  }
  scanDir(geoSystemPath(), null);
  return nodes;
}

function scanLocations() {
  const nodes = [];
  function scanDir(dir, depth = 0) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { scanDir(fullPath, depth + 1); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const parsed = parseMdFile(fullPath);
      if (!parsed) continue;
      const id = normalizeId(parsed.fileName);
      const parentLink = parsed.frontmatter['上层区域'];
      let parentId = null;
      if (parentLink && parentLink !== '无') parentId = normalizeId(parentLink.replace(/\[\[|\]\]/g, '').trim());
      const tags = Array.isArray(parsed.frontmatter['tags']) ? parsed.frontmatter['tags'] : [];
      // frontmatter `层级` 字段为权威来源（中文，如 设施/地点/城市），缺失时回退启发式
      const explicitLayer = parsed.frontmatter['层级'] ? LAYER_KEYWORDS[parsed.frontmatter['层级']] : null;
      const layer = explicitLayer || detectLocationLayer(parsed.frontmatter, parsed.content, parsed.fileName);
      nodes.push({
        id, name: parsed.fileName, layer, layerLabel: LAYER_LABELS[layer] || layer,
        parentId, tags, sourcePath: parsed.relativePath, wikilinks: parsed.wikilinks,
        placeType: parsed.frontmatter['地点类型'] || null,
        coordinate: { x: null, y: null },
      });
    }
  }
  scanDir(locationsPath());
  return nodes;
}

// 索引文件行缓存（批次C3）：extractWorldsAndStars 与 worldStarMap 构建共用一次读取
let _indexLines = null;
function getIndexLines() {
  if (_indexLines) return _indexLines;
  const raw = fs.readFileSync(indexPath(), 'utf-8');
  _indexLines = matter(raw).content.split('\n');
  return _indexLines;
}

function extractWorldsAndStars(lines) {
  try {
    const worlds = [];
    const galaxies = []; // star systems
    let currentWorld = null;
    let currentStarDomain = null;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Match world headers
      const worldMatch = trimmed.match(/^# ([^\s#].*?)$/);
      if (worldMatch && !worldMatch[1].includes('发布') && !worldMatch[1].includes('tags')) {
        const worldName = worldMatch[1].trim();
        currentWorld = { id: normalizeId(worldName), name: worldName, layer: 'world', layerLabel: '世界', parentId: null, tags: ['世界'], sourcePath: '01 索引/地理系统索引.md', wikilinks: [], coordinate: { x: null, y: null } };
        worlds.push(currentWorld);
        currentStarDomain = null;
        continue;
      }
      
      if (!currentWorld) continue;
      
      // 匹配带缩进的 wikilink 列表项，用缩进级别区分层级：
      //   level 0（无缩进）    -> 星域
      //   level 1（1 tab/2空格）-> 恒星系（恒星级）
      //   level >=2            -> 行星及以下（由文件夹扫描提供，此处忽略）
      const listMatch = line.match(/^([\t ]*)- \[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
      if (!listMatch) continue;
      
      const indentStr = listMatch[1];
      const itemName = listMatch[2].trim();
      const level = (indentStr.match(/\t/g) || []).length + Math.floor((indentStr.match(/ /g) || []).length / 2);
      
      if (level === 0) {
        // 星域
        currentStarDomain = { id: normalizeId(itemName), name: itemName };
      } else if (level === 1 && currentStarDomain) {
        // 恒星系（星域下）
        galaxies.push({
          id: normalizeId(itemName),
          name: itemName,
          layer: 'galaxy',
          layerLabel: '星系',
          parentId: currentStarDomain.id,
          tags: ['星系'],
          sourcePath: '01 索引/地理系统索引.md',
          wikilinks: [],
          coordinate: { x: null, y: null }
        });
      }
    }
    
    return { worlds, galaxies };
  } catch (e) { console.error('读取索引失败:', e.message); return { worlds: [], galaxies: [] }; }
}

function detectLayer(folderName) {
  for (const [keyword, layer] of Object.entries(LAYER_KEYWORDS)) {
    if (folderName.includes(keyword)) return layer;
  }
  return null;
}

function detectLayerFromPath(filePath) {
  const parts = filePath.split(path.sep);
  for (const part of parts) { const l = detectLayer(part); if (l) return l; }
  return null;
}

/**
 * 场景地点粒度识别（三级策略）：
 *   1. 文件名/别名后缀模式（最可靠）：X城→city, X镇→town, X村→village,
 *      X岛→region（岛屿是区域而非城镇）, X府/宫/殿/馆/院/楼/塔/寺/庙/坛/阁/堂/厅/站/厂/店→facility
 *   2. tags 匹配（补充）：城市/城镇/村庄/建筑/宫殿/神殿/学校/医院/图书馆/咖啡厅/餐厅/超市/工厂/监狱/祭坛/广场/城堡/花园/湖泊/岛屿/空间站/飞船/战舰
 *   3. 内容关键词（兜底，最不可靠）
 */
const LAYER_SUFFIX_RULES = [
  { suffix: '城', layer: 'city' },
  { suffix: '镇', layer: 'town' },
  { suffix: '村', layer: 'village' },
  { suffix: '岛', layer: 'region' },
  { suffix: '半岛', layer: 'region' },
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
  { suffix: '钟楼', layer: 'building' },
  { suffix: '城堡', layer: 'building' },
  { suffix: '花园', layer: 'building' },
  { suffix: '公寓', layer: 'building' },
  { suffix: '大厦', layer: 'building' },
  { suffix: '教堂', layer: 'building' },
  { suffix: '神殿', layer: 'building' },
  { suffix: '神庙', layer: 'building' },
  { suffix: '学校', layer: 'building' },
  { suffix: '医院', layer: 'building' },
  { suffix: '图书馆', layer: 'building' },
  { suffix: '博物馆', layer: 'building' },
  { suffix: '剧院', layer: 'building' },
  { suffix: '剧院', layer: 'building' },
  { suffix: '竞技场', layer: 'building' },
  { suffix: '兵营', layer: 'building' },
  { suffix: '工坊', layer: 'building' },
  { suffix: '仓库', layer: 'building' },
  { suffix: '塔楼', layer: 'building' },
  { suffix: '别墅', layer: 'building' },
  { suffix: '住宅', layer: 'building' },
  { suffix: '宅邸', layer: 'building' },
  { suffix: '宫殿', layer: 'building' },
  { suffix: '教堂', layer: 'building' },
  { suffix: '寺庙', layer: 'building' },
  { suffix: '修道院', layer: 'building' },
  { suffix: '灯塔', layer: 'building' },
  { suffix: '工坊', layer: 'building' },
  { suffix: '矿井', layer: 'building' },
  { suffix: '港口', layer: 'building' },
  { suffix: '码头', layer: 'building' },
  { suffix: '车站', layer: 'building' },
  { suffix: '机场', layer: 'building' },
  { suffix: '市场', layer: 'building' },
  { suffix: '广场', layer: 'building' },
  { suffix: '公园', layer: 'building' },
  { suffix: '庭院', layer: 'building' },
  { suffix: '走廊', layer: 'building' },
  { suffix: '门厅', layer: 'building' },
  { suffix: '大厅', layer: 'building' },
  { suffix: '房间', layer: 'building' },
  { suffix: '楼层', layer: 'building' },
  { suffix: '地下室', layer: 'building' },
  { suffix: '阁楼', layer: 'building' },
  { suffix: '屋顶', layer: 'building' },
  { suffix: '墙壁', layer: 'building' },
  { suffix: '城墙', layer: 'building' },
  { suffix: '城门', layer: 'building' },
  { suffix: '城堡', layer: 'building' },
  { suffix: '宫殿', layer: 'building' },
  { suffix: '要塞', layer: 'building' },
  { suffix: '堡垒', layer: 'building' },
  { suffix: '避难所', layer: 'building' },
  { suffix: '营地', layer: 'building' },
  { suffix: '哨站', layer: 'building' },
  { suffix: '前哨', layer: 'building' },
  { suffix: '殖民地', layer: 'building' },
  { suffix: '定居点', layer: 'building' },
  { suffix: '村落', layer: 'village' },
  { suffix: '山', layer: 'location' },
  { suffix: '江', layer: 'location' },
  { suffix: '河', layer: 'location' },
  { suffix: '湖', layer: 'location' },
  { suffix: '谷', layer: 'location' },
  { suffix: '林', layer: 'location' },
  { suffix: '原', layer: 'location' },
];

const TAG_LAYER_MAP = {
  '城市': 'city', '城邦': 'city', '城镇': 'town', '村庄': 'village',
  '建筑': 'facility', '宫殿': 'facility', '神殿': 'facility', '学校': 'facility',
  '医院': 'facility', '图书馆': 'facility', '咖啡厅': 'facility', '餐厅': 'facility',
  '超市': 'facility', '工厂': 'facility', '监狱': 'facility', '祭坛': 'facility',
  '广场': 'facility', '城堡': 'facility', '花园': 'facility', '湖泊': 'location',
  '岛屿': 'region', '空间站': 'facility', '飞船': 'facility', '战舰': 'facility',
  '地下室': 'facility', '地下铁路': 'facility', '遗迹': 'facility', '地宫': 'facility',
  '酒楼': 'facility', '面包店': 'facility', '广播站': 'facility', '传送门': 'facility',
  '工作室': 'facility', '钟楼': 'facility', '军械库': 'facility', '神社': 'facility',
  '墓园': 'facility', '墓场': 'facility', '庇护所': 'facility', '监狱': 'facility',
};

function detectLocationLayer(frontmatter, content, fileName) {
  const names = [fileName, frontmatter['名称'], frontmatter['别名']].filter(Boolean).flatMap(v => Array.isArray(v) ? v : [String(v)]);
  if (!names.length && frontmatter.title) names.push(String(frontmatter.title));
  
  // 1. 文件名/别名后缀模式（取最长匹配优先，如 半岛 > 岛）
  const sortedRules = [...LAYER_SUFFIX_RULES].sort((a, b) => b.suffix.length - a.suffix.length);
  for (const name of names) {
    for (const rule of sortedRules) {
      if (name.endsWith(rule.suffix)) return rule.layer;
    }
  }
  
  // 2. tags 匹配
  const tags = Array.isArray(frontmatter['tags']) ? frontmatter['tags'] : [];
  for (const tag of tags) {
    if (TAG_LAYER_MAP[tag]) return TAG_LAYER_MAP[tag];
  }
  // tags 前缀匹配（如 "建筑（地下室）"）
  for (const tag of tags) {
    for (const [key, layer] of Object.entries(TAG_LAYER_MAP)) {
      if (tag.includes(key)) return layer;
    }
  }
  
  // 3. 内容关键词兜底
  if (frontmatter['类别']) {
    const cat = frontmatter['类别'];
    if (cat.includes('城市') || cat.includes('首都')) return 'city';
    if (cat.includes('城镇') || cat.includes('镇')) return 'town';
    if (cat.includes('村庄')) return 'village';
    if (cat.includes('建筑') || cat.includes('设施')) return 'facility';
    if (cat.includes('区域')) return 'region';
  }
  if (content.includes('城市')) return 'city';
  if (content.includes('城镇')) return 'town';
  return 'location';
}

function normalizeId(name) {
  if (!name) return 'unknown';
  return name.replace(/\[\[|\]\]/g, '').replace(/[\s\\/]/g, '_').replace(/[^\w一-鿿]/g, '').toLowerCase();
}

/**
 * 从地点 tags 中提取区域（region）节点。
 * 规则：
 *   - 共享该 tag 的地点数 ≥ 2（避免单点误判）
 *   - 排除粒度词/通用词（城市、建筑、场景地点等）
 *   - 排除与已有节点同名的 tag（如 风神城 是城市名不是区域）
 *   - parentId = 共享地点的最常见父级（如 乐园星）
 */
const REGION_EXCLUDE_TAGS = new Set([
  '场景地点', '城市', '城镇', '村庄', '建筑', '神殿', '宫殿', '学校', '医院',
  '图书馆', '咖啡厅', '餐厅', '超市', '工厂', '监狱', '祭坛', '广场', '城堡',
  '花园', '湖泊', '岛屿', '空间站', '飞船', '战舰', '地下室', '地下铁路', '遗迹',
  '地宫', '酒楼', '面包店', '广播站', '传送门', '工作室', '钟楼', '军械库', '神社',
  '墓园', '墓场', '庇护所', '世界', '星系', '星域', '行星', '索引', '地理系统',
  '卫星', '发布', '说明', '模板文件', '异质空间', '里世界', '移动设施',
]);

function extractRegions(allNodes) {
  const tagCount = {};
  const tagParents = {};
  allNodes.forEach(n => {
    if (!n.tags) return;
    n.tags.forEach(t => {
      tagCount[t] = (tagCount[t] || 0) + 1;
      if (!tagParents[t]) tagParents[t] = {};
      if (n.parentId) tagParents[t][n.parentId] = (tagParents[t][n.parentId] || 0) + 1;
    });
  });
  
  const existingIds = new Set(allNodes.map(n => n.id));
  const regions = [];
  
  Object.entries(tagCount).forEach(([tag, count]) => {
    if (count < 2) return;
    if (REGION_EXCLUDE_TAGS.has(tag)) return;
    if (existingIds.has(normalizeId(tag))) return; // tag 本身就是地点/节点名
    
    // 取共享地点的最常见父级
    const parents = tagParents[tag];
    let parentId = null;
    if (parents) {
      const entries = Object.entries(parents).sort((a, b) => b[1] - a[1]);
      if (entries.length > 0) parentId = entries[0][0];
    }
    
    regions.push({
      id: normalizeId(tag),
      name: tag,
      layer: 'region',
      layerLabel: '区域',
      parentId,
      tags: [tag],
      sourcePath: '',
      wikilinks: [],
      coordinate: { x: null, y: null },
    });
  });
  
  return regions;
}

function mergeNodes(geo, loc, worlds, galaxies) {
  const map = new Map();
  const collisions = [];
  [...geo, ...loc].forEach(n => {
    if (map.has(n.id)) {
      collisions.push({ id: n.id, name: n.name, existing: map.get(n.id).sourcePath, incoming: n.sourcePath });
    } else {
      map.set(n.id, n);
    }
  });
  worlds.forEach(w => { if (!map.has(w.id)) map.set(w.id, w); });
  galaxies.forEach(g => { if (!map.has(g.id)) map.set(g.id, g); });
  
  if (collisions.length > 0) {
    console.warn(`[提取] 发现 ${collisions.length} 个跨目录重名节点（后出现的被忽略，可能导致多世界数据丢失）:`);
    collisions.forEach(c => console.warn(`  - "${c.name}" (${c.existing} vs ${c.incoming})`));
  }
  
  // Resolve parent references
  const all = Array.from(map.values());
  all.forEach(n => {
    if (!n.parentId) return;
    if (map.has(n.parentId)) return;
    // Try to find by name
    const parent = all.find(x => x.name.toLowerCase() === n.parentId.toLowerCase());
    if (parent) n.parentId = parent.id;
    else n.parentId = null;
  });
  
  return all;
}

function resolveParents(nodes, worldStarMap) {
  const map = new Map(nodes.map(n => [n.id, n]));
  for (const [worldId, starIds] of Object.entries(worldStarMap)) {
    for (const sid of starIds) {
      if (map.has(sid) && !map.get(sid).parentId) map.get(sid).parentId = worldId;
    }
  }
  nodes.forEach(n => {
    if (n.parentId) return;
    for (const link of n.wikilinks) {
      const lid = normalizeId(link);
      if (map.has(lid) && isHigherLayer(map.get(lid).layer, n.layer)) {
        n.parentId = lid;
        break;
      }
    }
  });
  return nodes;
}

function isHigherLayer(l1, l2) {
  const i1 = LAYER_ORDER.indexOf(l1);
  const i2 = LAYER_ORDER.indexOf(l2);
  return i1 !== -1 && i2 !== -1 && i1 < i2;
}

function initializeCoordinates(nodes) {
  const layers = {};
  nodes.forEach(n => { if (!layers[n.layer]) layers[n.layer] = []; layers[n.layer].push(n); });
  
  LAYER_ORDER.forEach((layer, idx) => {
    const lnodes = layers[layer];
    if (!lnodes || lnodes.length === 0) return;
    const radius = 80 + idx * 100;
    const angleStep = (2 * Math.PI) / Math.max(lnodes.length, 1);
    lnodes.forEach((n, i) => {
      if (n.coordinate.x !== null && n.coordinate.y !== null) return;
      const angle = i * angleStep - Math.PI / 2;
      n.coordinate.x = Math.round(600 + radius * Math.cos(angle));
      n.coordinate.y = Math.round(400 + radius * Math.sin(angle));
    });
  });
  return nodes;
}

/**
 * 自动生成初始航道（基于距离阈值）
 */
function generateAutoHyperlanes(nodes) {
  const hyperlanes = [];
  const galaxies = nodes.filter(n => n.layer === 'galaxy');
  const domainMap = new Map();
  
  // 建立星域到星系的映射
  galaxies.forEach(g => {
    if (g.parentId) {
      if (!domainMap.has(g.parentId)) domainMap.set(g.parentId, []);
      domainMap.get(g.parentId).push(g);
    }
  });
  
  // 按距离生成航道
  for (let i = 0; i < galaxies.length; i++) {
    for (let j = i + 1; j < galaxies.length; j++) {
      const g1 = galaxies[i];
      const g2 = galaxies[j];
      if (g1.coordinate.x === null || g2.coordinate.x === null) continue;
      
      const dist = Math.hypot(g1.coordinate.x - g2.coordinate.x, g1.coordinate.y - g2.coordinate.y);
      if (dist < 400) {
        const crossDomain = g1.parentId !== g2.parentId;
        hyperlanes.push({
          id: `auto_${g1.id}_${g2.id}`,
          fromId: g1.id,
          toId: g2.id,
          type: crossDomain ? 'cross_domain' : 'local',
          auto: true,  // 标记为自动生成
          controlPoints: []
        });
      }
    }
  }
  return hyperlanes;
}

/**
 * 保留司天中用户创建的节点（sourcePath 为空的节点不在 Markdown 中，
 * 重新提取时若不合并会被静默丢弃 —— 数据丢失）
 */
function mergeUserCreatedNodes(allNodes, cachePath) {
  if (!fs.existsSync(cachePath)) return allNodes;
  try {
    const old = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const oldNodes = old.nodes || [];
    const existingIds = new Set(allNodes.map(n => n.id));
    const userCreated = oldNodes.filter(n => !n.sourcePath);
    let added = 0;
    for (const n of userCreated) {
      if (!existingIds.has(n.id)) {
        allNodes.push(n);
        existingIds.add(n.id);
        added++;
      }
    }
    if (added > 0) console.log(`保留司天用户创建节点: ${added} 个（${userCreated.map(n => n.name).join('、')}）`);
  } catch (e) {
    console.warn('[提取] 读取旧缓存失败，跳过用户节点保留:', e.message);
  }
  return allNodes;
}

async function extractGeodata(targetVault, options = {}) {
  if (targetVault) vaultPath = targetVault;
  const forceFull = !!options.forceFull;
  console.log(`开始提取地理数据...${forceFull ? '（强制全量）' : ''}`);

  // 批次C3：增量提取——加载指纹缓存（--full / forceFull 跳过）
  if (!forceFull) loadParseCache();
  else parseCache.files = {};
  _indexLines = null; // vault 切换时重置索引行缓存

  const geoNodes = scanGeoSystem();
  console.log(`地理系统节点: ${geoNodes.length}`);

  const locationNodes = scanLocations();
  console.log(`场景地点节点: ${locationNodes.length}`);

  const { worlds, galaxies } = extractWorldsAndStars(getIndexLines());
  console.log(`世界节点: ${worlds.length}, 星系节点: ${galaxies.length}`);

  // 增量提取统计 + 清理已删除文件的缓存条目
  if (parseCache.misses > 0 || parseCache.hits > 0) {
    console.log(`解析缓存: 复用 ${parseCache.hits} 个未变更文件，重新解析 ${parseCache.misses} 个`);
  }
  for (const rel of Object.keys(parseCache.files)) {
    if (!parseCache.seen.has(rel)) delete parseCache.files[rel];
  }
  saveParseCache();

  let allNodes = mergeNodes(geoNodes, locationNodes, worlds, galaxies);
  console.log(`合并后总数: ${allNodes.length}`);
  
  // 保留司天用户创建的节点（sourcePath 为空），避免重新提取时丢失
  allNodes = mergeUserCreatedNodes(allNodes, path.join(vaultPath, '.sitian', 'geodata.json'));
  
  // 从地点 tags 提取区域节点（两城流域等），合并进节点列表
  const regionNodes = extractRegions(allNodes);
  if (regionNodes.length > 0) {
    const existingIds = new Set(allNodes.map(n => n.id));
    regionNodes.forEach(r => { if (!existingIds.has(r.id)) allNodes.push(r); });
    console.log(`区域节点: ${regionNodes.map(r => r.name).join('、')}`);
  }
  
  // Build world-star map from index for parent resolution（批次C3：与上方共用一次索引读取）
  const worldStarMap = {};
  let cw = null;
  for (const line of getIndexLines()) {
    const tm = line.trim();
    const wm = tm.match(/^# ([^\s#].*?)$/);
    if (wm) { cw = normalizeId(wm[1]); worldStarMap[cw] = []; continue; }
    const sm = tm.match(/^- \[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
    if (sm && cw) worldStarMap[cw].push(normalizeId(sm[1]));
  }
  
  allNodes = resolveParents(allNodes, worldStarMap);
  allNodes = initializeCoordinates(allNodes);
  
  // 自动生成初始航道
  const autoHyperlanes = generateAutoHyperlanes(allNodes);
  console.log(`自动生成航道: ${autoHyperlanes.length}`);
  
  return {
    version: '0.1.0',
    extractedAt: new Date().toISOString(),
    vaultPath,
    nodeCount: allNodes.length,
    nodes: allNodes,
    hyperlanes: autoHyperlanes,
  };
}

module.exports = { extractGeodata };

if (require.main === module) {
  (async () => {
    // CLI 支持 --vault <path> 指定库目录（2026-08-16 可配置化）；--full 强制全量提取（忽略解析缓存，批次C3）
    const vaultArgIdx = process.argv.indexOf('--vault');
    const targetVault = vaultArgIdx !== -1 ? process.argv[vaultArgIdx + 1] : undefined;
    const forceFull = process.argv.includes('--full');
    const data = await extractGeodata(targetVault, { forceFull });
    const outPath = path.join(vaultPath, '.sitian', 'geodata.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`提取完成！数据已保存至: ${outPath}`);
    console.log(`总节点数: ${data.nodeCount}`);
  })();
}
