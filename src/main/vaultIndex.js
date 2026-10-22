// src/main/vaultIndex.js — 全库只读索引（D1 / T1-T2，2026-10-19）
//
// 为什么要有它（S0 实测）：
//   `scripts/extract-data.js` 只回答“哪些笔记能成为**地图节点**”，而且只认两个硬编码目录
//   （1,353 篇里只扫 141 篇）。人物/组织/事件/物品这些“资料”在司天里没有任何入口。
//   本模块补的是**另一个问题**：库里有什么、标题/标签/双链/首段是什么 —— 只读、不写笔记、
//   不碰画布，供搜索、阅读器、要素绑定使用。
//
// 口径（红线）：
//   · 只读：不写 Markdown、不碰项目文件；唯一的写是 `.sitian/note-index.json`（可删可重建）；
//   · 不 import Electron：纯 Node，可用 Node 单测（测试靠临时目录 + 直接 require）；
//   · 路径必须在库根内（readNote 做 containment），防止渲染层借 IPC 读任意文件；
//   · 与提取器的关系：提取器继续决定“地图节点”；本索引决定“资料条目”。两者用 path 关联，
//     谁都不覆盖谁。
//
// 🔴 2026-10-22（三刀序列·第二刀「读料桥」）：
//   索引不再只记「有层级/在扫描目录」这类粗判，而是对**整份 frontmatter**做一次启发归类
//   （`scripts/lib/vaultClassify.js`，纯函数 + Node 单测），并把「认不出来的」逐条落进
//   `classifyReport().needsHuman`。上层缺失分三种：显式字段 / 正文双链 / 正文句式，
//   后两者标 `inferred:true` 并带证据；都找不到 → `needsHuman: 'spatial'`，**不猜**。
'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const { SCAN_SCOPE, LAYER_KEYWORDS, LAYER_LABELS, LAYER_SUFFIX_RULES, normalizeRelPath } = require('../../scripts/extract-data');
const classify = require('../../scripts/lib/vaultClassify');

const INDEX_VERSION = 2;   // v2：条目带 classification（升级会强制重建一次，缓存可丢）
const INDEX_FILE = 'note-index.json';
const MAX_NOTE_BYTES = 2 * 1024 * 1024;      // 单篇正文读取上限（防止把巨型附件当笔记读）
const MAX_FILES = 50000;                      // 防御性上限（真实库 1.3k；不给出无穷 walk）

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git', '.obsidian', '.sitian', '.trash', '.tmp', 'node_modules', '__pycache__', '.lab-edge-profile', '.test-edge-profile',
]);

const MAP_LAYER_ORDER = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'building', 'facility', 'location'];

function posix(p) { return String(p || '').replace(/\\/g, '/'); }

/** 库内相对路径（统一 `/`）；超出库根返回空串 */
function relOf(root, abs) {
  const rel = normalizeRelPath(path.relative(root, abs));
  if (!rel || rel.startsWith('..')) return '';
  return rel;
}

/** 递归收集 `.md`（跳过排除目录与符号链接；包含 `_` 开头的模板，但标记 underscore） */
function walkMarkdown(root, opts = {}) {
  const exclude = new Set(opts.excludeDirs || DEFAULT_EXCLUDE_DIRS);
  const out = [];
  const rootAbs = path.resolve(root);
  function walk(dir) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclude.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!/\.md$/i.test(entry.name)) continue;
      const rel = relOf(rootAbs, full);
      if (rel) out.push(rel);
    }
  }
  walk(rootAbs);
  return out.sort((a, b) => a.localeCompare(b, 'zh'));
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

function stripBrackets(s) {
  return String(s || '').replace(/\[\[|\]\]/g, '').split('|')[0].trim();
}

/** frontmatter `层级`（中文标签或英文 id）→ 内部 layer */
function layerFromFrontmatter(fm) {
  const raw = fm && (fm['层级'] != null ? fm['层级'] : fm.layer);
  if (raw == null) return null;
  const v = String(raw).trim();
  if (LAYER_KEYWORDS[v]) return LAYER_KEYWORDS[v];
  if (LAYER_LABELS[v]) return v;
  return null;
}

/** 路径里的层级关键词（目录名包含「星域/星系/行星/区域/城市…」） */
function layerFromPath(rel) {
  const segs = posix(rel).split('/');
  for (const seg of segs) {
    for (const [cn, id] of Object.entries(LAYER_KEYWORDS)) {
      if (seg.includes(cn)) return id;
    }
  }
  return null;
}

function firstHeading(content) {
  const m = String(content || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function headingsOf(content) {
  const out = [];
  const re = /^#{2,3}\s+(.+)$/gm;
  let m;
  while ((m = re.exec(String(content || ''))) !== null && out.length < 5) out.push(m[1].trim());
  return out;
}

function firstLineOf(content) {
  for (const line of String(content || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('---')) continue;
    if (t.startsWith('>')) continue;
    if (t.startsWith('|')) continue;
    return t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a).slice(0, 160);
  }
  return '';
}

function wikilinksOf(content) {
  const out = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(String(content || ''))) !== null) out.push(m[1].trim());
  return [...new Set(out)];
}

function isUnderScanDir(rel, scanDirs) {
  const p = posix(rel);
  return (scanDirs || []).some((d) => p === d || p.startsWith(String(d).replace(/\\/g, '/') + '/'));
}

/** 只留「短小」的 frontmatter 值（索引文件别被长字段撑大；报告里够用） */
function trimFm(fm) {
  const out = {};
  for (const [k, v] of Object.entries(fm || {})) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 10).map((x) => String(x).slice(0, 200));
    } else if (typeof v === 'object') {
      out[k] = JSON.stringify(v).slice(0, 200);
    } else {
      out[k] = String(v).slice(0, 200);
    }
  }
  return out;
}

/** 解析一篇笔记 → 索引条目；解析失败也返回条目（带 parseError），不让整库失败 */
function parseEntry(root, rel, st, scanDirs = DEFAULT_SCAN_DIRS) {
  const abs = path.join(root, ...rel.split('/'));
  const name = path.basename(rel).replace(/\.md$/i, '');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const entry = {
    path: rel, name, dir,
    title: name,
    mtimeMs: Math.round(st.mtimeMs || 0),
    size: st.size || 0,
    tags: [], aliases: [], headings: [], firstLine: '', wikilinks: [], fmKeys: [],
    fm: {},
    contentSample: '',
    layerHint: null,
    classification: null,
    underscore: name.startsWith('_'),
  };
  let raw = '';
  try {
    raw = fs.readFileSync(abs, 'utf-8');
    const parsed = matter(raw.replace(/^\uFEFF/, ''));
    // 脏 frontmatter 抢救（全角冒号 / TOML 等号 / 键名带空格）—— 归类与字段读取共用这一份
    const fm = classify.normalizeFrontmatter(parsed.data || {});
    const content = parsed.content || '';
    entry.title = String(fm['名称'] || fm.title || firstHeading(content) || name).trim() || name;
    entry.tags = classify.asTagList(fm.tags);
    entry.aliases = asArray(fm['别名'] != null ? fm['别名'] : fm.aliases);
    entry.headings = headingsOf(content);
    entry.firstLine = firstLineOf(content);
    entry.wikilinks = wikilinksOf(content);
    entry.fmKeys = Object.keys(fm);
    entry.fm = trimFm(fm);
    // 只留开头一段正文：双链已在 wikilinks 里，这里给「位于…」这类句式推断用
    entry.contentSample = content.slice(0, 500);
    entry.classification = classify.classifyNote({
      path: rel,
      name,
      title: entry.title,
      tags: entry.tags,
      aliases: entry.aliases,
      fm,
      content: entry.contentSample,
    }, { layerKeywords: LAYER_KEYWORDS, suffixRules: LAYER_SUFFIX_RULES });
    entry.layerHint = entry.classification.layer;
    const parentField = classify.pickField(fm, classify.PARENT_FIELDS);
    entry.parentTitle = parentField.key ? classify.stripBrackets(parentField.value) : '';
    entry.parentField = parentField.key || '';
    entry.placeType = fm['地点类型'] != null ? String(fm['地点类型']) : '';
  } catch (e) {
    entry.parseError = String((e && e.message) || e).slice(0, 200);
    entry.classification = {
      category: 'unknown', categoryLabel: classify.CATEGORY_LABELS.unknown,
      layer: null, confidence: 'low',
      evidence: [{ signal: 'parse', detail: `解析失败：${entry.parseError}` }],
      needsHuman: ['category'],
    };
  }
  const cat = entry.classification ? entry.classification.category : 'unknown';
  // 旧字段 `kind` 的含义保持「地图 / 资料」两档（UI 与搜索在用）；`unknown` 单列，便于报告
  entry.kind = cat === 'geo' ? 'map' : (cat === 'unknown' ? 'unknown' : 'lore');
  return entry;
}

const DEFAULT_SCAN_DIRS = [SCAN_SCOPE.geoSystem, SCAN_SCOPE.locations];

function indexPathOf(root) { return path.join(root, '.sitian', INDEX_FILE); }

function loadIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPathOf(root), 'utf-8'));
    if (raw && raw.version === INDEX_VERSION && posix(raw.root) === posix(root)) return raw;
  } catch (e) { /* 缺失/损坏 → 重建 */ }
  return null;
}

function saveIndex(root, index) {
  const p = indexPathOf(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * 建索引（增量：mtimeMs+size 指纹命中则复用条目）。
 * @param {string} root 库根
 * @param {{forceFull?:boolean, excludeDirs?:string[], scanDirs?:string[], write?:boolean}} [opts]
 *        `write:false` = **只读模式**（不落 `note-index.json`）—— 读料 CLI / 只读取证用，
 *        对用户的库连 `.sitian` 都不碰。
 * @returns {{index:object, summary:object}}
 */
function buildIndex(root, opts = {}) {
  const t0 = Date.now();
  const rootAbs = path.resolve(root);
  const prev = opts.forceFull ? null : loadIndex(rootAbs);
  const prevFiles = (prev && prev.files) || {};
  const scanDirs = opts.scanDirs || DEFAULT_SCAN_DIRS;
  const files = {};
  let hits = 0, misses = 0, parseErrors = 0;
  const list = walkMarkdown(rootAbs, opts);
  for (const rel of list) {
    let st;
    try { st = fs.statSync(path.join(rootAbs, ...rel.split('/'))); } catch (e) { continue; }
    const old = prevFiles[rel];
    if (old && old.mtimeMs === Math.round(st.mtimeMs || 0) && old.size === (st.size || 0)
        && old.classification) {
      files[rel] = old;
      hits += 1;
      continue;
    }
    const entry = parseEntry(rootAbs, rel, st, scanDirs);
    if (entry.parseError) parseErrors += 1;
    files[rel] = entry;
    misses += 1;
  }
  const byTop = {};
  for (const rel of Object.keys(files)) {
    const top = rel.includes('/') ? rel.split('/')[0] : '(根目录)';
    byTop[top] = (byTop[top] || 0) + 1;
  }
  const byCategory = {};
  for (const e of Object.values(files)) {
    const c = (e.classification && e.classification.category) || 'unknown';
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  const index = {
    version: INDEX_VERSION,
    root: rootAbs,
    builtAt: new Date().toISOString(),
    files,
    stats: {
      total: Object.keys(files).length,
      byTop,
      byCategory,
      hits, misses, parseErrors,
      elapsedMs: Date.now() - t0,
      scanDirs,
    },
  };
  if (opts.write !== false) saveIndex(rootAbs, index);
  return { index, summary: index.stats };
}

/** 只读状态（不重建；索引不存在时 exists=false） */
function indexStatus(root) {
  const idx = loadIndex(root);
  if (!idx) return { exists: false, root: path.resolve(root), indexFile: indexPathOf(root) };
  return {
    exists: true,
    root: idx.root,
    builtAt: idx.builtAt,
    indexFile: indexPathOf(root),
    stats: idx.stats,
    sizeBytes: (() => { try { return fs.statSync(indexPathOf(root)).size; } catch (e) { return 0; } })(),
  };
}

/**
 * 把 wikilink 目标（标题/别名/文件名/相对路径）解析成一篇笔记。
 * 重名时返回候选清单；阅读器先开第一个，并把候选数显示出来。
 */
function resolveNote(index, name) {
  const q = String(name || '').trim().replace(/^#/, '').replace(/\.md$/i, '');
  if (!q || !index || !index.files) return { path: null, candidates: [] };
  const low = (s) => String(s || '').toLowerCase();
  const files = Object.values(index.files);
  const exact = files.filter((e) => low(e.title) === low(q) || low(e.name) === low(q));
  const alias = files.filter((e) => (e.aliases || []).some((a) => low(a) === low(q)));
  const byPath = files.filter((e) => low(e.path) === low(q + '.md') || low(e.path).endsWith('/' + low(q) + '.md'));
  const pool = exact.length ? exact : (alias.length ? alias : byPath);
  const uniq = [];
  const seen = new Set();
  for (const e of pool) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    uniq.push({ path: e.path, title: e.title, kind: e.kind });
  }
  return { path: uniq[0] ? uniq[0].path : null, candidates: uniq.slice(0, 12) };
}

/**
 * 路径 containment：只允许读库根内的文件。
 * @throws {Error} 越界 / 不存在 / 过大
 */
function assertInside(root, rel) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) throw new Error('路径越界：只能读知识库根目录内的文件');
  return abs;
}

/** 读一篇笔记（只读；2MB 上限） */
function readNote(root, rel) {
  const abs = assertInside(root, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size > MAX_NOTE_BYTES) throw new Error('笔记过大（>2MB），已拒绝读取');
  const raw = fs.readFileSync(abs, 'utf-8');
  const parsed = matter(raw);
  return {
    path: normalizeRelPath(rel),
    mtimeMs: Math.round(st.mtimeMs || 0),
    size: st.size,
    frontmatter: parsed.data || {},
    content: parsed.content || '',
    wikilinks: wikilinksOf(parsed.content || ''),
  };
}

/**
 * 索引内搜索（标题/别名/标签/小标题/首段/路径），不读正文。
 * 正文全文搜索留给 D2（需要按需 readNote）。
 */
function searchIndex(index, query, limit = 50) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !index || !index.files) return [];
  const out = [];
  for (const e of Object.values(index.files)) {
    let score = 0;
    const title = String(e.title || '').toLowerCase();
    if (title === q) score = 100;
    else if (title.startsWith(q)) score = 80;
    else if (title.includes(q)) score = 60;
    if (!score && (e.aliases || []).some((a) => String(a).toLowerCase().includes(q))) score = 50;
    if (!score && (e.tags || []).some((t) => String(t).toLowerCase().includes(q))) score = 40;
    if (!score && (e.headings || []).some((h) => String(h).toLowerCase().includes(q))) score = 30;
    if (!score && String(e.firstLine || '').toLowerCase().includes(q)) score = 20;
    if (!score && String(e.path || '').toLowerCase().includes(q)) score = 10;
    if (score) out.push({ path: e.path, title: e.title, layerHint: e.layerHint, kind: e.kind, score });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh'));
  return out.slice(0, limit);
}

/**
 * 正文全文搜索（D2）：元数据命中优先，再按需读正文；返回 snippet。
 * 🔴 只在用户显式搜索时调用；不要挂在 watcher 的每个事件上（1,353 篇全读会拖慢主线程）。
 */
function searchIndexDeep(root, index, query, limit = 50) {
  const q = String(query || '').trim();
  if (!q || !index || !index.files) return [];
  const out = [];
  const seen = new Set();
  for (const r of searchIndex(index, q, limit)) {
    out.push({ ...r, matchedIn: 'meta' });
    seen.add(r.path);
  }
  const low = q.toLowerCase();
  let scanned = 0;
  for (const e of Object.values(index.files)) {
    if (out.length >= limit) break;
    if (seen.has(e.path)) continue;
    if (scanned >= 2000) break;
    scanned += 1;
    let raw = '';
    try { raw = fs.readFileSync(path.join(root, ...e.path.split('/')), 'utf-8'); } catch (err) { continue; }
    if (raw.length > MAX_NOTE_BYTES) continue;
    const body = raw.replace(/^---[\s\S]*?---\n/, '');
    const at = body.toLowerCase().indexOf(low);
    if (at < 0) continue;
    const from = Math.max(0, at - 50);
    const snippet = body.slice(from, Math.min(body.length, at + q.length + 70)).replace(/\s+/g, ' ').trim();
    out.push({
      path: e.path, title: e.title, layerHint: e.layerHint, kind: e.kind,
      score: 15, matchedIn: 'content', snippet,
    });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh'));
  return out.slice(0, limit);
}

// ── 附件读取（D2 阅读器）：图片/附件只读、限库根、限 8MB ─────────────────
const ASSET_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};
const ASSET_MAX_BYTES = 8 * 1024 * 1024;
const assetMaps = new Map();     // root -> Map(basenameLower -> rel)

function buildAssetMap(root) {
  const map = new Map();
  const rootAbs = path.resolve(root);
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (/\.md$/i.test(entry.name)) continue;
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile() || st.size > ASSET_MAX_BYTES) continue;
      const rel = relOf(rootAbs, full);
      if (!rel) continue;
      const key = entry.name.toLowerCase();
      if (!map.has(key)) map.set(key, rel);
    }
  }
  walk(rootAbs);
  return map;
}

function findAsset(root, name, fromNote) {
  const clean = String(name || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!clean) return null;
  const tryRel = (rel) => {
    try {
      const abs = assertInside(root, rel);
      if (fs.statSync(abs).isFile()) return normalizeRelPath(rel);
    } catch (e) { /* 继续 */ }
    return null;
  };
  let hit = tryRel(clean);
  if (!hit && fromNote) hit = tryRel(path.posix.join(path.posix.dirname(fromNote), clean));
  if (!hit) {
    if (!assetMaps.has(root)) assetMaps.set(root, buildAssetMap(root));
    hit = assetMaps.get(root).get(path.basename(clean).toLowerCase()) || null;
  }
  return hit;
}

/** 读附件 → dataUrl（阅读器 <img> 直接用；不注册自定义协议，避免多一层 Electron 权限） */
function readAsset(root, name, fromNote) {
  const rel = findAsset(root, name, fromNote);
  if (!rel) throw new Error(`找不到附件：${name}`);
  const abs = assertInside(root, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size > ASSET_MAX_BYTES) throw new Error('附件过大（>8MB），已拒绝读取');
  const ext = path.extname(rel).toLowerCase();
  const mime = ASSET_MIME[ext] || 'application/octet-stream';
  const b64 = fs.readFileSync(abs).toString('base64');
  return { path: rel, mime, size: st.size, dataUrl: `data:${mime};base64,${b64}` };
}

/** 实体发现规则（默认 = 现有 SCAN_SCOPE，保证 ROSA 行为零变化） */
function defaultRules() {  return {
    scanDirs: [...DEFAULT_SCAN_DIRS],
    fieldKeys: ['层级', '上层区域', '地点类型'],
    layerKeywords: { ...LAYER_KEYWORDS },
    maxCandidates: 500,
  };
}

/**
 * 全库归类报告（纯函数：不写盘、不改索引）。
 *
 * 这就是「识别不了的每条都有报告」的落点：`needsHuman` 里既有 `category`（完全认不出）
 * 也有 `layer`（认得出是地点但认不出粒度）与 `spatial`/`parent-missing`（找不到上层）。
 * 每条都带 `reasons` 与 `evidence`（信号 + 命中值），人可以逐条核对，不是黑箱。
 *
 * @returns {{total:number, byCategory:object, byLayer:object, geo:Array,
 *            needsHuman:Array, inferred:Array, categories:object}}
 */
function classifyReport(index, opts = {}) {
  const entries = Object.values((index && index.files) || {});
  return classify.buildReport(entries, {
    layerOrder: MAP_LAYER_ORDER,
    ...opts,
  });
}

/**
 * 从索引里挑“可能是地图实体”的候选（**只读，不导入**）。
 *
 * 判定 v2（2026-10-22）：以 `classification.category === 'geo'` 为准 —— 显式层级、类型值、
 * 组织/物品/书名等非地理键、结构目录、标签、路径层级词、文件名后缀，都算「凭据」；
 * 凭据写进 `reasons`。**认不出的笔记不会进候选**（进 `needsHuman`），避免 1,353 篇
 * 全被算成实体。
 *
 * @returns {{count:number, candidates:Array, byLayer:object, needsHuman:Array, counts:object}}
 */
function discoverCandidates(index, rules = defaultRules()) {
  const r = { ...defaultRules(), ...rules };
  const report = classifyReport(index);
  const cands = [];
  for (const g of report.geo) {
    const entry = index.files[g.path] || {};
    cands.push({
      path: g.path,
      title: g.title,
      layer: g.layer,
      layerLabel: g.layer ? (LAYER_LABELS[g.layer] || g.layer) : null,
      parentTitle: g.parentTitle || '',
      parentPath: g.parentPath || '',
      parentInferred: !!g.parentInferred,
      tags: entry.tags || [],
      confidence: g.confidence,
      reasons: (g.evidence || []).map((x) => `${x.signal}：${x.detail}`),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  cands.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || a.path.localeCompare(b.path, 'zh'));
  const byLayer = {};
  for (const c of cands) { const k = c.layer || 'unknown'; byLayer[k] = (byLayer[k] || 0) + 1; }
  const limited = cands.slice(0, r.maxCandidates);
  return {
    count: cands.length,
    candidates: limited,
    byLayer,
    // 报告随候选一起回传：面板能立刻说「还有 N 条待人工」，而不是只给一张优等生名单
    needsHuman: report.needsHuman.slice(0, 200),
    counts: {
      total: report.total,
      byCategory: report.byCategory,
      inferred: report.inferred.length,
      needsHuman: report.needsHuman.length,
    },
  };
}

module.exports = {
  INDEX_VERSION,
  INDEX_FILE,
  DEFAULT_SCAN_DIRS,
  DEFAULT_EXCLUDE_DIRS,
  walkMarkdown,
  buildIndex,
  loadIndex,
  indexStatus,
  readNote,
  searchIndex,
  searchIndexDeep,
  resolveNote,
  readAsset,
  findAsset,
  defaultRules,
  discoverCandidates,
  classifyReport,
  layerFromFrontmatter,
  layerFromPath,
  MAP_LAYER_ORDER,
};
