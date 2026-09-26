const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const matter = require('gray-matter');

// 运行时路径（由 startWatcher(vaultPath) 设置，避免硬编码本地路径）
let currentVaultPath = null;
let vaultPaths = null;

/**
 * 根据知识库路径生成各子路径
 */
function resolveVaultPaths(vaultPath) {
  if (!vaultPath) return null;
  return {
    vault: vaultPath,
    geoSystem: path.join(vaultPath, '03 设定', '11 地理系统'),
    locations: path.join(vaultPath, '03 设定', '02 场景地点'),
    index: path.join(vaultPath, '01 索引', '地理系统索引.md'),
    cache: path.join(vaultPath, '.sitian', 'geodata.json'),
  };
}

function setVaultPath(vaultPath) {
  currentVaultPath = vaultPath;
  vaultPaths = resolveVaultPaths(vaultPath);
}

function getVaultPath() {
  return currentVaultPath;
}

function getVaultPaths() {
  return vaultPaths;
}

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

// ⚠️ 与 scripts/extract-data.js（唯一真值来源）及 src/renderer/src/utils/normalizeId.js **逐字符一致**。
// 2026-09-16 修正历史漂移：此处曾写作 /[\\\/\\s]/（把字面量 s 也当分隔符、反而不匹配空白），
// 导致同一个文件名在「增量监听」与「全量提取」下得到不同 id。三处一致性由
// scripts/tests/cases/test_40_draft_id_continuity.py 的源码比对用例守卫。
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
    const vault = getVaultPath();
    if (!vault) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    const wikilinks = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) wikilinks.push(match[1].trim());
    return { frontmatter, content, wikilinks, fileName: path.basename(filePath, '.md'), relativePath: path.relative(vault, filePath) };
  } catch (e) {
    console.error(`解析失败: ${filePath}`, e.message);
    return null;
  }
}

// ── 叙事状态（2026-09-24）────────────────────────────────────────────────────
// `status` 是**笔记侧字段**：用户在 Obsidian frontmatter 里写，司天只读、不回写
// （方向与 `coordinate` 相反 —— 那个是司天写进笔记、提取时读回）。
// ⚠️ 别名表与 src/renderer/src/utils/entityStatus.js 的 ENTITY_STATUSES **必须一致**，
//    由 scripts/tests/unit/test_entity_status.js 读源码比对守卫（两处 CJS 副本也要逐项相同）。
// 接受 `status`（推荐，与 `coordinate` 同为机器字段）与 `状态`（中文别名，迁就中文库里手写）。
const STATUS_ALIASES = {
  // 机器 id
  active: 'active', destroyed: 'destroyed', ruined: 'ruined', sealed: 'sealed', lost: 'lost', unknown: 'unknown',
  // 中文 label（entityStatus 里的 label）
  '存在': 'active', '已毁灭': 'destroyed', '已荒废': 'ruined', '已封印': 'sealed', '已失联': 'lost', '状态未知': 'unknown',
  // 中文短标签（entityStatus 里的 short，用于徽标）
  '毁灭': 'destroyed', '荒废': 'ruined', '封印': 'sealed', '失联': 'lost', '未知': 'unknown',
};

/**
 * 从 frontmatter 读「叙事状态」→ 归一化为状态 id；读不出就返回 **null（视作未设置）**。
 * 字段本身仍会落在节点上（值为 null），与既有 `placeType` 同一风格。
 *
 * 为什么认不出要返回 null 而不是原样带着：脏值在渲染侧虽会被 `resolveStatus` 回落成 active，
 * 但它会被**原样写进项目文件并长期留存**（重提取也带回来）—— 用户之后看到更困惑。
 * `active` 同样返回 null：「显式写了存在」与「没写」的行为完全等价（渲染侧 `resolveStatus` 会把 null 也当 active）。
 */
function readFrontmatterStatus(fm) {
  const raw = fm && (fm.status != null ? fm.status : fm['状态']);
  if (raw == null) return null;
  const id = STATUS_ALIASES[String(raw).trim()];
  return id && id !== 'active' ? id : null;
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
    coordinate: { x: null, y: null },
    status: readFrontmatterStatus(parsed.frontmatter),
  };
}

function readCache() {
  try {
    const paths = getVaultPaths();
    if (!paths) return { nodes: [], hyperlanes: [] };
    const raw = fs.readFileSync(paths.cache, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { nodes: [], hyperlanes: [] };
  }
}

function writeCache(data) {
  const paths = getVaultPaths();
  if (!paths) return;
  fs.writeFileSync(paths.cache, JSON.stringify(data, null, 2), 'utf-8');
}

function updateNodeInCache(node) {
  const data = readCache();
  const idx = data.nodes.findIndex(n => n.id === node.id);
  
  if (idx !== -1) {
    // 保留用户已编辑的坐标（关键：不覆盖用户拖拽后的位置）
    const existingCoord = data.nodes[idx].coordinate;
    const preservedCoord = (existingCoord && existingCoord.x !== null && existingCoord.y !== null)
      ? existingCoord
      : node.coordinate;
    // ⚠️ 必须**先铺开旧节点再盖新字段**（2026-09-24 修）：
    //    旧写法 `{ ...node, coordinate }` 只保留坐标 —— 而 `extractSingleFile` 不产出
    //    `placeType` / `uuid` 等**编辑器侧字段**，于是「在 Obsidian 里改一个字」就会把它们从缓存里抹掉
    //    （表现为图标配色退化、uuid 消失 —— 全是静默的，不报错）。
    //    正确语义：文件变更只更新**笔记侧字段**，编辑器侧字段原样保留。
    data.nodes[idx] = { ...data.nodes[idx], ...node, coordinate: preservedCoord };
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
  const vault = getVaultPath();
  if (!vault) return;
  const relativePath = path.relative(vault, filePath);
  const fileName = path.basename(filePath, '.md');
  const nodeId = normalizeId(fileName);
  
  console.log(`[Watcher] 文件变更: ${relativePath}`);
  
  const node = extractSingleFile(filePath);
  if (!node) return;
  
  const data = updateNodeInCache(node);
  
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

function startWatcher(window, vaultPath) {
  if (watcher) return;
  
  mainWindow = window;
  
  // 运行时设置路径（不硬编码，由调用方传入）
  if (vaultPath) setVaultPath(vaultPath);
  const paths = getVaultPaths();
  if (!paths) {
    console.error('[Watcher] 未设置知识库路径，watcher 未启动');
    return;
  }
  
  const watchPaths = [
    paths.geoSystem,
    paths.locations,
    paths.index,
  ];
  
  watcher = chokidar.watch(watchPaths, {
    ignored: /(^|[\\/\\\\])\\../,
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

// STATUS_ALIASES / readFrontmatterStatus 一并导出：test_entity_status 要读它与前端的注册表比对（防漂移）
module.exports = { startWatcher, stopWatcher, setVaultPath, getVaultPath, STATUS_ALIASES, readFrontmatterStatus };
