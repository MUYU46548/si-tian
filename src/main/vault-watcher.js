const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const matter = require('gray-matter');

const VAULT_PATH = 'E:/图书馆/ROSA';
const GEO_SYSTEM_PATH = path.join(VAULT_PATH, '03 设定', '11 地理系统');
const LOCATIONS_PATH = path.join(VAULT_PATH, '03 设定', '02 场景地点');
const INDEX_PATH = path.join(VAULT_PATH, '01 索引', '地理系统索引.md');
const CACHE_PATH = path.join(VAULT_PATH, '.sitian', 'geodata.json');

const LAYER_KEYWORDS = {
  '星系': 'galaxy', '星域': 'star_domain', '行星': 'planet', '恒星': 'star',
  '卫星': 'moon', '区域': 'region', '城镇': 'town', '城市': 'city',
};

const LAYER_LABELS = {
  world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
  planet: '行星', moon: '卫星', region: '区域', city: '城市',
  town: '城镇', village: '村庄', facility: '设施', location: '地点', unknown: '未知'
};

const LAYER_ORDER = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'facility', 'location', 'unknown'];

let watcher = null;
let mainWindow = null;
let debounceTimer = null;

function normalizeId(name) {
  if (!name) return 'unknown';
  return name.replace(/\[\[|\]\]/g, '').replace(/[\\\/\s]/g, '_').replace(/[^\w一-鿿]/g, '').toLowerCase();
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

function parseMdFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    const wikilinks = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) wikilinks.push(match[1].trim());
    return { frontmatter, content, wikilinks, fileName: path.basename(filePath, '.md'), relativePath: path.relative(VAULT_PATH, filePath) };
  } catch (e) {
    console.error(`解析失败: ${filePath}`, e.message);
    return null;
  }
}

function extractSingleFile(filePath) {
  const parsed = parseMdFile(filePath);
  if (!parsed) return null;

  const id = normalizeId(parsed.fileName);
  let layer = parsed.frontmatter['层级'] || detectLayerFromPath(filePath) || 'unknown';
  layer = LAYER_KEYWORDS[layer] || layer;
  const parentLink = parsed.frontmatter['上层区域'];
  let parentId = null;
  if (parentLink && parentLink !== '无') parentId = normalizeId(parentLink.replace(/\[\[|\]\]/g, '').trim());
  const tags = Array.isArray(parsed.frontmatter['tags']) ? parsed.frontmatter['tags'] : [];

  return {
    id, name: parsed.fileName, layer, layerLabel: LAYER_LABELS[layer] || layer,
    parentId, tags, sourcePath: parsed.relativePath, wikilinks: parsed.wikilinks,
    coordinate: { x: null, y: null }
  };
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { nodes: [], hyperlanes: [] };
  }
}

function writeCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function updateNodeInCache(node) {
  const data = readCache();
  const idx = data.nodes.findIndex(n => n.id === node.id);
  
  if (idx !== -1) {
    // 保留坐标
    const existingCoord = data.nodes[idx].coordinate;
    data.nodes[idx] = { ...node, coordinate: existingCoord };
  } else {
    data.nodes.push(node);
  }
  
  writeCache(data);
  return data;
}

function removeNodeFromCache(nodeId) {
  const data = readCache();
  data.nodes = data.nodes.filter(n => n.id !== nodeId);
  writeCache(data);
  return data;
}

function handleFileChange(filePath) {
  const relativePath = path.relative(VAULT_PATH, filePath);
  const fileName = path.basename(filePath, '.md');
  const nodeId = normalizeId(fileName);
  
  console.log(`[Watcher] 文件变更: ${relativePath}`);
  
  // 重新提取该文件
  const node = extractSingleFile(filePath);
  if (!node) return;
  
  // 更新缓存
  const data = updateNodeInCache(node);
  
  // 通知渲染进程
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:node-updated', { node, data });
  }
}

function handleFileRemoved(filePath) {
  const fileName = path.basename(filePath, '.md');
  const nodeId = normalizeId(fileName);
  
  console.log(`[Watcher] 文件删除: ${filePath}`);
  
  const data = removeNodeFromCache(nodeId);
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:node-removed', { nodeId, data });
  }
}

function startWatcher(window) {
  if (watcher) return;
  
  mainWindow = window;
  
  const watchPaths = [
    GEO_SYSTEM_PATH,
    LOCATIONS_PATH,
    INDEX_PATH,
  ];
  
  watcher = chokidar.watch(watchPaths, {
    ignored: /(^|[\/\\])\../, // 忽略隐藏文件
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });
  
  watcher
    .on('add', handleFileChange)
    .on('change', handleFileChange)
    .on('unlink', handleFileRemoved)
    .on('error', error => console.error('[Watcher] 错误:', error));
  
  console.log('[Watcher] 文件监听已启动');
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    mainWindow = null;
    console.log('[Watcher] 文件监听已停止');
  }
}

module.exports = { startWatcher, stopWatcher };
