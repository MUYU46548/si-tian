const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const VAULT_PATH = 'E:/图书馆/ROSA';
const GEO_SYSTEM_PATH = path.join(VAULT_PATH, '03 设定', '11 地理系统');
const LOCATIONS_PATH = path.join(VAULT_PATH, '03 设定', '02 场景地点');
const INDEX_PATH = path.join(VAULT_PATH, '01 索引', '地理系统索引.md');

const LAYER_KEYWORDS = {
  '星系': 'galaxy',
  '星域': 'star_domain',
  '行星': 'planet',
  '恒星': 'star',
  '卫星': 'moon',
  '区域': 'region',
  '城镇': 'town',
  '城市': 'city',
};

const LAYER_LABELS = {
  world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
  planet: '行星', moon: '卫星', region: '区域', city: '城市',
  town: '城镇', village: '村庄', facility: '设施', location: '地点', unknown: '未知'
};

const LAYER_ORDER = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'facility', 'location', 'unknown'];

function parseMdFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    const wikilinks = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) wikilinks.push(match[1].trim());
    return { frontmatter, content, wikilinks, fileName: path.basename(filePath, '.md'), relativePath: path.relative(VAULT_PATH, filePath) };
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
        nodes.push({ id, name: parsed.fileName, layer, layerLabel: LAYER_LABELS[layer] || layer, parentId, tags, sourcePath: parsed.relativePath, wikilinks: parsed.wikilinks, coordinate: { x: null, y: null } });
      }
    }
  }
  scanDir(GEO_SYSTEM_PATH, null);
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
      const layer = detectLocationLayer(parsed.frontmatter, parsed.content);
      nodes.push({ id, name: parsed.fileName, layer, layerLabel: LAYER_LABELS[layer] || layer, parentId, tags, sourcePath: parsed.relativePath, wikilinks: parsed.wikilinks, coordinate: { x: null, y: null } });
    }
  }
  scanDir(LOCATIONS_PATH);
  return nodes;
}

function extractWorldsAndStars() {
  try {
    const raw = fs.readFileSync(INDEX_PATH, 'utf-8');
    const { content } = matter(raw);
    const lines = content.split('\n');
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
      
      // Match star domains
      const domainMatch = trimmed.match(/^- \[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
      if (domainMatch) {
        const domainName = domainMatch[1].trim();
        const domainId = normalizeId(domainName);
        currentStarDomain = { id: domainId, name: domainName };
        continue;
      }
      
      // Match galaxies (star systems) under domains
      const galaxyMatch = trimmed.match(/^- \[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
      if (galaxyMatch && currentStarDomain) {
        const galaxyName = galaxyMatch[1].trim();
        galaxies.push({
          id: normalizeId(galaxyName),
          name: galaxyName,
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

function detectLocationLayer(frontmatter, content) {
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

function mergeNodes(geo, loc, worlds, galaxies) {
  const map = new Map();
  [...geo, ...loc].forEach(n => { if (!map.has(n.id)) map.set(n.id, n); });
  worlds.forEach(w => { if (!map.has(w.id)) map.set(w.id, w); });
  galaxies.forEach(g => { if (!map.has(g.id)) map.set(g.id, g); });
  
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

async function extractGeodata(vaultPath = VAULT_PATH) {
  console.log('开始提取地理数据...');
  
  const geoNodes = scanGeoSystem();
  console.log(`地理系统节点: ${geoNodes.length}`);
  
  const locationNodes = scanLocations();
  console.log(`场景地点节点: ${locationNodes.length}`);
  
  const { worlds, galaxies } = extractWorldsAndStars();
  console.log(`世界节点: ${worlds.length}, 星系节点: ${galaxies.length}`);
  
  let allNodes = mergeNodes(geoNodes, locationNodes, worlds, galaxies);
  console.log(`合并后总数: ${allNodes.length}`);
  
  // Build world-star map from index for parent resolution
  const raw = fs.readFileSync(INDEX_PATH, 'utf-8');
  const { content } = matter(raw);
  const worldStarMap = {};
  let cw = null;
  for (const line of content.split('\n')) {
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
    const data = await extractGeodata();
    const outPath = path.join(VAULT_PATH, '.sitian', 'geodata.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`提取完成！数据已保存至: ${outPath}`);
    console.log(`总节点数: ${data.nodeCount}`);
  })();
}
