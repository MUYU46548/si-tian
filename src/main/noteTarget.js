// src/main/noteTarget.js — 新建笔记「放哪个目录 + 写什么 frontmatter」的**唯一实现**（2026-10-24）
//
// 为什么单独成模块：这两件事以前散在 `create-obsidian-note` 的 if/else 里，
// 于是「落点规则」和「frontmatter 该带什么」都没法单测，也没法被第二批创建口（批量导入）复用。
//
// 落点规则（用户 2026-10-24 拍板）：
//   ① payload 显式给了 `targetDir` → 用它（用户指定的目录，库内相对或绝对都行）；
//   ② 库里有约定根目录（`03 设定`）→ 用层级子目录（星域/星系/行星 / 02 场景地点）；
//   ③ **连约定根都没有 → 落到库根目录**（`usedRootFallback: true`）。
//   ⚠️ ② 的判据是"`03 设定` 存在"，不是"子目录存在"：不在别人的库里凭空造一棵
//      `03 设定/11 地理系统/...`（那属于替他改库结构）；子目录仍会自动建。
//
// frontmatter 口径（同一次拍板，选项 B）：
//   · 写 `层级`（中文键，与库内规范/提取器一致），**不再写英文 `layer`**；
//   · `上层区域` 优先用父节点**名字**（wikilink 要能解析到真笔记；父 id 只是兜底）；
//   · **绝不写 `coordinate`** —— AGENTS 红线「坐标永不写入 frontmatter」；
//   · 其它插件键一律不碰。

const path = require('path');

/** 层级 → 库内目录（相对库根）。地理三层单独成目录，其余地点类统一进「02 场景地点」。 */
const LAYER_DIRS = {
  star_domain: ['03 设定', '11 地理系统', '星域'],
  galaxy: ['03 设定', '11 地理系统', '星系'],
  planet: ['03 设定', '11 地理系统', '行星'],
  __default: ['03 设定', '02 场景地点'],
};

/** 层级 → 库内 `层级` 字段的中文标签（与库的枚举一致；未知层级回落到原值） */
const LAYER_LABELS = {
  world: '世界',
  star_domain: '星域',
  galaxy: '星系',
  star: '恒星',
  planet: '行星',
  region: '区域',
  city: '城市',
  town: '城镇',
  village: '村庄',
  building: '设施',
  facility: '设施',
  location: '地点',
};

function layerDirOf(layer) {
  return LAYER_DIRS[layer] || LAYER_DIRS.__default;
}

/**
 * 解析新建笔记的目标目录（绝对路径）。
 *
 * @param {object} p
 * @param {string} p.vault     库根（绝对路径）
 * @param {string} [p.layer]   节点层级（决定约定子目录）
 * @param {string} [p.targetDir] 用户显式指定的目录（库内相对路径或绝对路径）
 * @param {(p:string)=>boolean} p.pathExists 目录存在性判定（注入以便单测，不在这里碰 fs）
 * @returns {{dir:string|null, source:'explicit'|'convention'|'root'|'rejected',
 *            usedRootFallback:boolean, layerDir:string[], reason?:string}}
 */
function resolveNoteTarget({ vault, layer, targetDir, pathExists } = {}) {
  if (!vault) throw new Error('未设置知识库路径');
  const exists = typeof pathExists === 'function' ? pathExists : () => false;
  const segs = layerDirOf(layer);

  if (targetDir && String(targetDir).trim()) {
    const abs = path.resolve(vault, String(targetDir).trim());
    // 🔴 显式目录也必须**留在库内**：绝不因为用户填错/填了绝对路径就把笔记写到库外
    const rel = path.relative(vault, abs);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!inside) {
      return {
        dir: null, source: 'rejected', usedRootFallback: false, layerDir: segs,
        reason: `指定的新笔记目录不在知识库内：${abs}`,
      };
    }
    return { dir: abs, source: 'explicit', usedRootFallback: false, layerDir: segs };
  }

  // ② 约定根目录存在才用（只探根，不探子目录）
  if (exists(path.join(vault, segs[0]))) {
    return { dir: path.join(vault, ...segs), source: 'convention', usedRootFallback: false, layerDir: segs };
  }

  // ③ 兜底：库根目录（不制造 `03 设定` 这棵树）
  return { dir: vault, source: 'root', usedRootFallback: true, layerDir: segs };
}

/**
 * 新建笔记的 frontmatter（**不含 coordinate**；选项 B：保留 层级 / 上层区域 / tags）。
 *
 * @param {object} p
 * @param {string} [p.layer]
 * @param {string[]} [p.tags]
 * @param {string} [p.parentName] 父节点**名字**（优先；wikilink 要能解析到真笔记）
 * @param {string} [p.parentId]   父节点 id（仅当没有名字时兜底）
 * @returns {object}
 */
function buildNoteFrontmatter({ layer, tags, parentName, parentId } = {}) {
  const fm = {};
  const label = LAYER_LABELS[layer] || (layer ? String(layer) : '');
  if (label) fm['层级'] = label;
  const list = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()) : [];
  if (list.length) fm.tags = list;
  const up = (parentName && String(parentName).trim()) || (parentId && String(parentId).trim()) || '';
  if (up) fm['上层区域'] = `[[${up}]]`;
  return fm;
}

module.exports = {
  LAYER_DIRS,
  LAYER_LABELS,
  layerDirOf,
  resolveNoteTarget,
  buildNoteFrontmatter,
};
