// scripts/lib/vaultClassify.js — 资料条目的「启发归类」纯函数层（2026-10-22，三刀序列·第二刀）
//
// 为什么单独一层：`src/main/vaultIndex.js` 负责**读盘**（walk / 增量指纹 / containment），
// `scripts/extract-data.js` 负责**变成地图节点**。两头都需要「这条笔记到底是什么」，
// 而这条判断必须是**纯函数、可单测、只有一份**——否则「索引里是人物、提取时算地点」
// 这类自相矛盾会静默存在（两边都不报错）。
//
// 输入是**已解析的条目**（不是文件）：`{ path, name, title, tags, aliases, fm, content }`。
// 输出：`{ category, layer, confidence, evidence[], needsHuman[] }`
//   · `category` 见 CATEGORIES —— 一定有一个值（含 `unknown`）；
//   · `unknown` = 没有任何可用信号 → **进「待人工」报告**，绝不静默当成地点/资料；
//   · `evidence` 记「凭什么这么判」（信号名 + 命中值），报告里逐条可核对；
//   · `layer` 只在 `category==='geo'` 时有意义；识别不出粒度时 `needsHuman` 带 `layer`。
//
// 原则：**不猜**。宁可 `unknown`，也不把「有个字像地名」的笔记塞进地图。
'use strict';

const GEO_LAYERS = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon',
  'region', 'city', 'town', 'village', 'building', 'facility', 'location'];

const CATEGORIES = {
  geo: 'geo',
  character: 'character',
  organization: 'organization',
  item: 'item',
  creature: 'creature',
  event: 'event',
  concept: 'concept',
  document: 'document',
  reference: 'reference',
  meta: 'meta',
  index: 'index',
  unknown: 'unknown',
};

const CATEGORY_LABELS = {
  geo: '地图实体',
  character: '人物',
  organization: '组织',
  item: '物品装备',
  creature: '种族/生物',
  event: '历史事件',
  concept: '概念/规则',
  document: '作品/文档',
  reference: '资料收藏',
  meta: '维护/模板',
  index: '索引',
  unknown: '待人工',
};

/** 非地理类里「显然是资料」的类目（报告里与「待人工」分开计） */
const LORE_CATEGORIES = ['character', 'organization', 'item', 'creature', 'event', 'concept', 'document', 'reference'];

/** `类型` / `类别` / `层级` 的**值** → 类目（中文库最常见的写法） */
const VALUE_CATEGORY = {
  主要角色: 'character', 次要角色: 'character', 旧作角色: 'character', 角色: 'character', 人物: 'character',
  组织: 'organization', 机构: 'organization', 势力: 'organization', 军队: 'organization',
  物品: 'item', 装备: 'item', 遗物: 'item', 道具: 'item', 武器: 'item', 工具: 'item', 食物: 'item',
  生物: 'creature', 怪物: 'creature', 种族: 'creature',
  事件: 'event', 历史事件: 'event', 年表: 'event',
  概念: 'concept', 术语: 'concept', 规则: 'concept', 魔法: 'concept', 科技: 'concept',
  作品: 'document', 书籍: 'document', 文档: 'document', 章节: 'document',
  资料: 'reference', 资料收藏: 'reference',
  索引: 'index',
  模板: 'meta', 说明: 'meta', 维护: 'meta',
  // 地点/城/镇… 交给 layer 表判（这里也写一份，供「层级=设施」这类直接命中）
  世界: 'geo', 星域: 'geo', 星系: 'geo', 恒星: 'geo', 行星: 'geo', 卫星: 'geo',
  区域: 'geo', 城市: 'geo', 城邦: 'geo', 城镇: 'geo', 村庄: 'geo', 建筑: 'geo',
  设施: 'geo', 地点: 'geo', 场所: 'geo',
};

/** frontmatter 键 → 类目（键本身就是强信号） */
const KEY_CATEGORY = {
  组织类型: 'organization',
  归属大类: 'item',
  书名: 'document',
  章节编号: 'document',
  章节: 'document',
  图片类型: 'document',
  文体类型: 'document',
  出处作品: 'document',
  作者: 'document',
};

/** 标签 → 类目（含前缀命中：`建筑（地下室）` 这类） */
const TAG_CATEGORY = {
  地理系统: 'geo', 场景地点: 'geo', 地点: 'geo', 星系: 'geo', 星域: 'geo', 行星: 'geo',
  城市: 'geo', 城镇: 'geo', 村庄: 'geo', 区域: 'geo', 建筑: 'geo', 设施: 'geo',
  森林: 'geo', 山脉: 'geo', 河流: 'geo', 湖泊: 'geo', 岛屿: 'geo', 海洋: 'geo',
  人物: 'character', 人物设定: 'character', 角色: 'character', 角色文档: 'character',
  组织: 'organization', 组织机构: 'organization', 势力: 'organization',
  物品: 'item', 物品装备: 'item', 装备: 'item', 武器: 'item', 军事装备: 'item', 道具: 'item',
  种族: 'creature', 生物: 'creature', 怪物: 'creature',
  事件: 'event', 历史事件: 'event', 年表: 'event',
  基础设定: 'concept', 文明: 'concept', 经济文化: 'concept', 军事: 'concept',
  魔法管制: 'concept', 扩展术语: 'concept', 秩序: 'concept', 规则: 'concept',
  作品: 'document', 官方作品: 'document', 同人作品: 'document',
  资料收藏: 'reference',
  模板文件: 'meta', 索引: 'index',
};

/**
 * 目录 → 类目（**结构优先于标签**：模板目录里哪怕打了「地理系统」tag 也还是模板）。
 * 正则按顺序匹配 posix 相对路径；`03 设定/11 地理系统` 这种带编号目录用前缀锚定。
 *
 * `structural: true` 的目录**先于 frontmatter 判断**：`99 模板/世界模板.md` 里写着
 * `层级: 世界`（模板示范给用户看），那是模板，不是世界本体。
 */
const DIR_RULES = [
  { re: /^07 资料收藏\//, category: 'reference', why: '资料收藏目录', structural: true },
  { re: /^96 事务管理\//, category: 'meta', why: '事务管理目录', structural: true },
  { re: /^99 模板\//, category: 'meta', why: '模板目录', structural: true },
  { re: /^02 帮助\//, category: 'meta', why: '帮助目录', structural: true },
  { re: /^00 主面板\//, category: 'meta', why: '主面板目录', structural: true },
  { re: /^Obsidian_AI_Sandbox\//, category: 'meta', why: 'AI 沙盒目录', structural: true },
  { re: /^01 索引\//, category: 'index', why: '索引目录', structural: true },
  { re: /(^|\/)资料收藏\//, category: 'reference', why: '资料收藏目录', structural: true },
  { re: /^06 年表\//, category: 'event', why: '年表目录' },
  { re: /^(04 官方作品|05 同人作品|100 公告与历史|12 相关项目)\//, category: 'document', why: '作品/公告目录' },
  { re: /^03 设定\/01 人物\//, category: 'character', why: '设定/人物目录' },
  { re: /^03 设定\/06 组织势力\//, category: 'organization', why: '设定/组织势力目录' },
  { re: /^03 设定\/13 物品装备\//, category: 'item', why: '设定/物品装备目录' },
  { re: /^03 设定\/(08 种族|09 生物|10 怪物|04 生物与怪物)\//, category: 'creature', why: '设定/生物目录' },
  { re: /^03 设定\/03 历史事件\//, category: 'event', why: '设定/历史事件目录' },
  { re: /^03 设定\/(11 地理系统|02 场景地点)\//, category: 'geo', why: '设定/地理·地点目录' },
  { re: /^03 设定\/(05 经济文化|07 魔法与科技|12 军事|14 秩序与规则|00 基础)\//, category: 'concept', why: '设定/概念类目录' },
  { re: /^03 设定\/04 计划\//, category: 'meta', why: '设定/计划目录' },
  // 无编号的同类目录（小库/手写库常见；fixture 里就有一批）
  { re: /(^|\/)人物\//, category: 'character', why: '人物目录' },
  { re: /(^|\/)组织\//, category: 'organization', why: '组织目录' },
  { re: /(^|\/)(物品|装备)\//, category: 'item', why: '物品目录' },
  { re: /(^|\/)(年表|事件)\//, category: 'event', why: '年表/事件目录' },
  { re: /(^|\/)地理\//, category: 'geo', why: '地理目录' },
  { re: /(^|\/)散装\/人物\//, category: 'character', why: '散装/人物目录' },
  { re: /(^|\/)散装\/组织\//, category: 'organization', why: '散装/组织目录' },
];

/** 父级字段别名（中英文；值是 wikilink 或纯文本） */
const PARENT_FIELDS = [
  '上层区域', '上层', '上级区域', '上级页面', '上级', '父级', '父页面', '父区域',
  'parent', 'parentId', '所在区域', '所属区域', '归属区域', '属于', '隶属', '位于',
];

/** 描述空间位置的正文句式（只认「动词 + 已知实体名」，不做模糊语义猜测） */
const TEXT_PARENT_PATTERNS = [
  // 「位于北境的海港」/「位于北境。」—— 名字后必须跟边界词或标点，避免把整句吃进来
  /(?:位于|坐落于|地处|处于)([^\s，。；、,.;]{2,24}?)(?:的|境内|之内|内|附近|以东|以西|以南|以北|东部|西部|南部|北部|一带|地区|之中|(?=[，。；、\s]|$))/,
  /(?:属于|隶属于|隶属|归属(?:于)?)([^\s，。；、,.;]{2,24}?)(?:的|境内|之内|内|附近|一带|地区|之中|(?=[，。；、\s]|$))/,
];

function asArray(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'object') return [];   // 对象不是列表（插件产物/脏数据）→ 当成没有
  return String(v).split(/[,，;；|、\n]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * tags 专用：Obsidian 允许 `tags: a b`、`tags: "#a #b"`、`tags: [a, b]` 三种写法。
 * 与 `asArray` 分开是因为别名**可以含空格**（"北 地" 是一个别名），标签不行。
 */
function asTagList(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => asTagList(x));
  if (typeof v === 'object') return [];
  return String(v)
    .split(/[\s,，;；|、]+/)
    .map((t) => t.replace(/^#+/, '').trim())
    .filter(Boolean);
}

/**
 * frontmatter 的「脏写法」抢救（用户提醒：真实库什么都可能写）：
 *   · `层级:　城市`（冒号后是全角空格）→ YAML 会把整行当**键名**、值为 null；
 *   · `层级：城市`（全角冒号）、`层级 = 城市`（TOML 风）；
 *   · 键名带前后空格。
 * 只在「键里含分隔符且值为空」时抢救，正常键值一律不动（不猜内容）。
 */
function normalizeFrontmatter(fm) {
  // YAML 坏到「整块被解析成一个字符串」时（例如 `层级:　城市` 用的是全角空格当分隔符），
  // gray-matter 会把整行当键名、data 变成字符串 —— 这里按行长抢救，能救多少救多少
  if (typeof fm === 'string') {
    const out = {};
    for (const line of fm.split(/\r?\n/)) {
      const m = line.match(/^\s*([^:：=]{1,40})\s*[:：=]\s*(.+?)\s*$/);
      if (m && m[1].trim() && m[2].trim()) out[m[1].trim()] = m[2].trim();
    }
    return out;
  }
  if (!fm || typeof fm !== 'object') return {};
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(fm)) {
    let key = String(rawKey).trim();
    let val = rawVal;
    if ((val === null || val === undefined) && /[:：=]/.test(key)) {
      const at = key.search(/[:：=]/);
      const k2 = key.slice(0, at).trim();
      const v2 = key.slice(at + 1).trim();
      if (k2 && v2) { key = k2; val = v2; }
    }
    if (!key) continue;
    out[key] = val;
  }
  return out;
}

function stripBrackets(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\[\[|\]\]/g, '')
    .split('|')[0]
    .trim();
}

function normName(s) {
  return stripBrackets(s)
    .replace(/[「」《》【】"'“”]/g, '')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
}

function firstHeading(content) {
  const m = String(content || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

/** 字段值规范化：去 [[ ]]、去首尾引号、去全角/半角空白（`层级: "[[城镇]]"` 也要认） */
function normValue(v) {
  return stripBrackets(
    String(v === null || v === undefined ? '' : v)
      .replace(/^["'“”]+|["'“”]+$/g, '')
  ).replace(/[\s\u3000]+/g, ' ').trim();
}

/** 取 frontmatter 里第一个有值的别名键 */
function pickField(fm, keys) {
  if (!fm) return { key: '', value: undefined };
  for (const k of keys) {
    const v = fm[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return { key: k, value: v };
  }
  return { key: '', value: undefined };
}

/**
 * 归类一条笔记。
 *
 * @param {object} entry `{ path, name, title, tags, aliases, fm, content }`
 * @param {{layerKeywords?:object, suffixRules?:Array, layerOrder?:string[]}} tables
 *        `layerKeywords` = 中文层级 → layer（`LAYER_KEYWORDS`，唯一来源在 extract-data）
 *        `suffixRules`  = 文件名后缀 → layer（`LAYER_SUFFIX_RULES`）
 * @returns {{category:string, categoryLabel:string, layer:string|null, confidence:string,
 *            evidence:Array<{signal:string, detail:string}>, needsHuman:string[]}}
 */
function classifyNote(entry, tables = {}) {
  const e = entry || {};
  const fm = normalizeFrontmatter(e.fm);
  const path = String(e.path || '').replace(/\\/g, '/');
  const name = String(e.name || '');
  const tags = asTagList(e.tags !== undefined ? e.tags : fm.tags);
  const layerKeywords = tables.layerKeywords || {};
  const suffixRules = tables.suffixRules || [];
  const evidence = [];
  const needsHuman = [];

  const hit = (category, signal, detail, confidence) => ({
    category,
    categoryLabel: CATEGORY_LABELS[category] || category,
    layer: null,
    confidence: confidence || 'medium',
    evidence: evidence.concat([{ signal, detail: String(detail) }]),
    needsHuman: [],
  });

  // ① 结构目录（模板/索引/事务/资料收藏）—— 这些**先于 frontmatter**：
  //    `99 模板/世界模板.md` 里写着「层级: 世界」是模板示例，不是世界本体。
  for (const rule of DIR_RULES) {
    if (!rule.structural || !rule.re.test(path)) continue;
    evidence.push({ signal: 'path', detail: rule.why });
    return hit(rule.category, 'path', rule.why, 'high');
  }
  // `_` 开头的笔记是「模板/说明」约定（真实库：`_地理系统_说明.md`）——不是实体
  if (name.startsWith('_')) {
    return hit('meta', 'name', '下划线前缀 = 模板/说明', 'medium');
  }

  // ② 显式层级（最强信号）。值既可能是 tier（设施），也可能是「事件」这类非地理类目。
  const layerField = pickField(fm, ['层级', '层次', 'layer', '层']);
  let explicitLayer = null;
  if (layerField.key) {
    const val = normValue(layerField.value);
    if (layerKeywords[val]) {
      explicitLayer = layerKeywords[val];
      evidence.push({ signal: `frontmatter.${layerField.key}`, detail: `${val} → ${explicitLayer}` });
    } else if (VALUE_CATEGORY[val] && VALUE_CATEGORY[val] !== 'geo') {
      evidence.push({ signal: `frontmatter.${layerField.key}`, detail: val });
      return { ...hit(VALUE_CATEGORY[val], `frontmatter.${layerField.key}`, val, 'high') };
    } else {
      evidence.push({ signal: `frontmatter.${layerField.key}`, detail: `${val}（未识别的层级值）` });
    }
  }

  // ③ frontmatter 键本身即类目（组织类型 / 归属大类 / 书名…）
  for (const [key, category] of Object.entries(KEY_CATEGORY)) {
    if (fm[key] !== undefined && fm[key] !== null && String(fm[key]).trim() !== '') {
      // 书名/章节编号这类只说明「这是一份作品文档」，优先级低于显式层级
      evidence.push({ signal: `frontmatter.${key}`, detail: String(fm[key]).slice(0, 40) });
      return hit(category, `frontmatter.${key}`, fm[key], 'high');
    }
  }

  // ④ `类型` / `类别` 的值（主要角色 / 遗物 / 组织…）
  for (const key of ['类型', '类别', '分类', 'type', 'category']) {
    const val = fm[key];
    if (val === undefined || val === null || String(val).trim() === '') continue;
    const v = String(val).trim();
    const cat = VALUE_CATEGORY[v];
    if (cat) {
      evidence.push({ signal: `frontmatter.${key}`, detail: v });
      if (cat !== 'geo') return hit(cat, `frontmatter.${key}`, v, 'high');
      continue; // 地理类目交给下面的 layer 解析
    }
  }

  // ⑤ 其它类目目录（设定/人物、设定/组织、地理·地点…）
  for (const rule of DIR_RULES) {
    if (rule.structural || !rule.re.test(path)) continue;
    evidence.push({ signal: 'path', detail: rule.why });
    if (rule.category === 'geo') {
      // 目录只说明「是地理类」，粒度另判
      return finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables);
    }
    return hit(rule.category, 'path', rule.why, 'high');
  }

  // ⑥ 标签
  for (const tag of tags) {
    const direct = TAG_CATEGORY[tag];
    if (direct) {
      evidence.push({ signal: 'tags', detail: tag });
      if (direct !== 'geo') return hit(direct, 'tags', tag, 'medium');
      return finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables);
    }
    for (const [key, cat] of Object.entries(TAG_CATEGORY)) {
      if (tag.includes(key)) {
        evidence.push({ signal: 'tags', detail: `${tag}（含「${key}」）` });
        if (cat !== 'geo') return hit(cat, 'tags', tag, 'medium');
        return finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables);
      }
    }
  }

  // ⑦ 路径里的层级词（`地理/北境`、`星域/`…）
  const pathLayer = layerFromPath(path, layerKeywords);
  if (pathLayer) {
    evidence.push({ signal: 'path', detail: `目录含层级词 → ${pathLayer}` });
    explicitLayer = explicitLayer || pathLayer;
    return finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables);
  }

  // ⑧ 文件名后缀（X城 / X港 / X宫…）—— 最弱的信号，只在前面的都落空时用
  const suffixLayer = layerFromName(name || e.title, suffixRules);
  if (suffixLayer) {
    evidence.push({ signal: 'name', detail: `后缀 → ${suffixLayer}` });
    explicitLayer = explicitLayer || suffixLayer;
    return finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables, 'low');
  }

  if (explicitLayer) {
    return finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables);
  }

  // ⑨ 都没有 → 待人工（**不猜**）
  return {
    category: 'unknown',
    categoryLabel: CATEGORY_LABELS.unknown,
    layer: null,
    confidence: 'low',
    evidence,
    needsHuman: ['category'],
  };
}

/** 地理类目的收尾：确定 layer 粒度；确定不了就标 needsHuman.layer（仍然算 geo） */
function finishGeo(evidence, explicitLayer, path, name, layerKeywords, suffixRules, tags, tables, confidence) {
  let layer = explicitLayer || layerFromPath(path, layerKeywords)
    || layerFromTags(tags, layerKeywords) || layerFromName(name, suffixRules);
  const needsHuman = [];
  if (!layer) needsHuman.push('layer');
  if (layer && GEO_LAYERS.indexOf(layer) < 0) {
    // 映射表给了非地理 layer（防御：不该发生）
    layer = null;
    needsHuman.push('layer');
  }
  if (needsHuman.length) evidence.push({ signal: 'layer', detail: '未能确定粒度（世界/星域/行星/城市…）' });
  return {
    category: 'geo',
    categoryLabel: CATEGORY_LABELS.geo,
    layer: layer || null,
    confidence: confidence || (explicitLayer ? 'high' : 'medium'),
    evidence,
    needsHuman: needsHuman,
  };
}

function layerFromPath(relPath, layerKeywords) {
  const segs = String(relPath || '').replace(/\\/g, '/').split('/');
  for (const seg of segs) {
    for (const [cn, layer] of Object.entries(layerKeywords)) {
      if (seg.includes(cn)) return layer;
    }
  }
  return null;
}

function layerFromName(name, suffixRules) {
  const n = String(name || '').trim();
  if (!n) return null;
  // 长后缀优先（半岛 > 岛、图书馆 > 馆）
  const sorted = suffixRules.slice().sort((a, b) => b.suffix.length - a.suffix.length);
  for (const rule of sorted) if (n.endsWith(rule.suffix)) return rule.layer;
  return null;
}

/** 标签本身就是层级词（`tags: [地点]` / `tags: [城市]`）→ 直接用那个层级 */
function layerFromTags(tags, layerKeywords) {
  for (const tag of (tags || [])) {
    if (layerKeywords[tag]) return layerKeywords[tag];
  }
  return null;
}

// ============================================================
// 空间关系推断（「缺上层」是读料桥最常缺的一块）
// ============================================================

/** 建立「名字 → 条目」索引（title / name / 别名，全部规范化） */
function buildNameIndex(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!e) continue;   // 脏输入（null/非对象）不能把整份报告带崩
    const keys = new Set();
    for (const k of [e.title, e.name, ...(asArray(e.aliases))]) {
      const n = normName(k);
      if (n) keys.add(n);
    }
    for (const k of keys) {
      if (!map.has(k)) map.set(k, e);
    }
  }
  return map;
}

function layerRank(layer, order) {
  const i = (order || GEO_LAYERS).indexOf(layer);
  return i < 0 ? 999 : i;
}

/**
 * 给一条 geo 条目找上层（**不造名字**：只认已有条目/显式字段/正文里点名的已知实体）。
 *
 * @param {object} entry 条目（需 `fm` / `content` / `wikilinks` / `classification`）
 * @param {{nameIndex:Map, layerOrder?:string[], parentFields?:string[]}} ctx
 * @returns {{parentTitle:string, parentPath:string, inferred:boolean, signal:string,
 *            evidence:string, resolvable:boolean} | {needsHuman:string, reason:string}}
 */
function inferParent(entry, ctx) {
  const e = entry || {};
  const fm = e.fm || {};
  const nameIndex = ctx.nameIndex || new Map();
  const layerOrder = ctx.layerOrder || GEO_LAYERS;
  const fields = ctx.parentFields || PARENT_FIELDS;
  const childLayer = e.classification && e.classification.layer;
  const selfNorm = normName(e.title) || normName(e.name);
  // 世界是根：没有上层是**正常**的，不该报「待人工」
  if (childLayer === 'world') return null;

  const resolve = (rawTitle) => {
    const n = normName(rawTitle);
    if (!n || n === selfNorm) return null;
    const target = nameIndex.get(n);
    if (!target) return null;
    if (target.path === e.path) return null;
    const tl = target.classification && target.classification.layer;
    // 上层必须比本条目**更宏观或同级**（不允许「城市的上层是城市里的建筑」）
    if (childLayer && tl && layerRank(tl, layerOrder) > layerRank(childLayer, layerOrder)) return null;
    return target;
  };

  // ① 显式字段
  const { key, value } = pickField(fm, fields);
  // `上层区域: 无` 是「明确没有上层」，不是「指向一个叫『无』的词条」
  const NO_PARENT = new Set(['无', '没有', 'none', 'null', '-', '—', 'n/a']);
  if (key && !NO_PARENT.has(String(stripBrackets(value)).trim().toLowerCase())) {
    const raw = stripBrackets(value);
    const target = resolve(raw);
    if (target) {
      return {
        parentTitle: target.title || target.name,
        parentPath: target.path,
        inferred: false,
        signal: `frontmatter.${key}`,
        evidence: `${key}: ${raw}`,
        resolvable: true,
      };
    }
    return {
      needsHuman: 'parent-missing',
      reason: `frontmatter.${key} 指向「${raw}」，但库里没有这个词条（不猜）`,
    };
  }

  // ② 正文 wikilink（第一个能解析到 geo 条目的链接）
  for (const link of (e.wikilinks || [])) {
    const target = resolve(link);
    if (!target) continue;
    if ((target.classification && target.classification.category) !== 'geo') continue;
    return {
      parentTitle: target.title || target.name,
      parentPath: target.path,
      inferred: true,
      signal: 'wikilink',
      evidence: `正文双链 [[${link}]]`,
      resolvable: true,
    };
  }

  // ③ 正文句式（只认「位于/隶属 + 已知实体名」；名字对不上就当没推断）
  //    索引条目只存开头一段（`contentSample`），完整正文由 readNote 按需读 —— 这里两种都吃。
  const text = String(e.content || e.contentSample || '');
  for (const re of TEXT_PARENT_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const target = resolve(m[1]);
    if (!target) continue;
    return {
      parentTitle: target.title || target.name,
      parentPath: target.path,
      inferred: true,
      signal: 'text',
      evidence: m[0].slice(0, 60),
      resolvable: true,
    };
  }

  return { needsHuman: 'spatial', reason: '没有任何上层线索（字段/双链/正文句式都没有）' };
}

/**
 * 汇总报告（纯函数；不写盘）。
 *
 * @param {Array} entries 索引条目（含 `classification`）
 * @param {{parentFields?:string[], layerOrder?:string[]}} [opts]
 * @returns {{total:number, byCategory:object, byLayer:object, geo:Array, needsHuman:Array,
 *            inferred:Array, categories:object}}
 */
function buildReport(entries, opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const nameIndex = buildNameIndex(list.filter((e) => e.classification && e.classification.category === 'geo'));
  const byCategory = {};
  const byLayer = {};
  const geo = [];
  const needsHuman = [];
  const inferred = [];

  for (const e of list) {
    if (!e) continue;
    const c = e.classification || classifyNote(e);
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    if (c.category !== 'geo') {
      if (c.category === 'unknown') {
        // 解析失败的条目要让人看得出是「文件坏了」，不是「没写字段」——
        // 两者的处理方式完全不同（后者补字段，前者修 YAML）
        const parseEv = (c.evidence || []).find((x) => x.signal === 'parse');
        needsHuman.push({
          path: e.path, title: e.title, category: 'unknown',
          reasons: parseEv
            ? [`frontmatter 解析失败：${parseEv.detail}`]
            : (c.needsHuman || []).map((r) => (r === 'category' ? '没有任何可用的分类信号' : r)),
          evidence: c.evidence || [],
        });
      }
      continue;
    }
    const parent = inferParent({ ...e, classification: c }, {
      nameIndex, layerOrder: opts.layerOrder, parentFields: opts.parentFields,
    }) || {};
    const row = {
      path: e.path,
      title: e.title,
      layer: c.layer,
      layerLabel: c.layer,
      confidence: c.confidence,
      parentTitle: parent.parentTitle || '',
      parentPath: parent.parentPath || '',
      parentInferred: !!parent.inferred,
      signal: parent.signal || '',
      evidence: c.evidence || [],
    };
    geo.push(row);
    byLayer[c.layer || 'unknown'] = (byLayer[c.layer || 'unknown'] || 0) + 1;
    if (parent.inferred) inferred.push({ path: e.path, title: e.title, ...parent, evidence: parent.evidence });
    for (const need of (c.needsHuman || [])) {
      needsHuman.push({
        path: e.path, title: e.title, category: 'geo',
        reasons: [need === 'layer' ? '认得出是地点，但认不出粒度（世界/星域/行星/城市…）' : need],
        evidence: c.evidence || [],
      });
    }
    if (parent.needsHuman) {
      needsHuman.push({
        path: e.path, title: e.title, category: 'geo',
        reasons: [parent.reason || '找不到上层'],
        evidence: c.evidence || [],
      });
    }
  }

  return {
    total: list.length,
    byCategory,
    byLayer,
    geo,
    needsHuman,
    inferred,
    categories: CATEGORY_LABELS,
  };
}

/** 报告 → Markdown（给人看的「待人工」清单；命令行与以后的面板共用） */
function reportToMarkdown(report) {
  const r = report || {};
  const lines = [];
  lines.push('# 读料结果与待人工清单');
  lines.push('');
  lines.push(`- 扫描条目：**${r.total || 0}**`);
  const cats = r.byCategory || {};
  lines.push(`- 分布：${Object.keys(cats).sort().map((k) => `${CATEGORY_LABELS[k] || k} ${cats[k]}`).join(' / ')}`);
  lines.push(`- 地图实体：**${(r.geo || []).length}**（其中上层为推断 ${(r.inferred || []).length} 条）`);
  lines.push(`- 待人工：**${(r.needsHuman || []).length}**`);
  lines.push('');
  lines.push('## 待人工（每一条都写了为什么）');
  lines.push('');
  const need = r.needsHuman || [];
  if (!need.length) lines.push('（无）');
  for (const n of need) {
    const why = (n.reasons || []).join('；');
    const ev = (n.evidence || []).map((x) => `${x.signal}=${x.detail}`).join('，');
    lines.push(`- \`${n.path}\`（${n.title || ''}）— ${why}${ev ? `｜依据：${ev}` : ''}`);
  }
  lines.push('');
  lines.push('## 推断出来的上层（请核对，不是事实）');
  lines.push('');
  const inf = r.inferred || [];
  if (!inf.length) lines.push('（无）');
  for (const x of inf) {
    lines.push(`- \`${x.path}\` → 上层「${x.parentTitle}」（${x.signal}：${x.evidence}）`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 输出目录不能在库内（只读取证的硬约束；CLI 与测试共用） */
function assertOutOutsideVault(outDir, vaultPath) {
  const path = require('path');
  const rel = path.relative(path.resolve(vaultPath), path.resolve(outDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return true;
  throw new Error(`输出目录在知识库内部（${outDir}）—— 只读取料不允许往库里写任何东西`);
}

module.exports = {
  GEO_LAYERS,
  CATEGORIES,
  CATEGORY_LABELS,
  LORE_CATEGORIES,
  VALUE_CATEGORY,
  KEY_CATEGORY,
  TAG_CATEGORY,
  DIR_RULES,
  PARENT_FIELDS,
  TEXT_PARENT_PATTERNS,
  classifyNote,
  inferParent,
  buildNameIndex,
  buildReport,
  reportToMarkdown,
  assertOutOutsideVault,
  // 供别的模块复用（避免各自再写一份规范化）
  asArray,
  asTagList,
  normalizeFrontmatter,
  stripBrackets,
  normName,
  firstHeading,
  layerFromPath,
  layerFromName,
  pickField,
  normValue,
};
