// utils/normalizeId.js — 节点 id 规范化（纯函数，前后端共用）
//
// ⚠️ 单一真值来源：scripts/extract-data.js 的 normalizeId（提取器实际使用的实现）。
// 本文件是它在 renderer 侧的**逐字符副本**（渲染进程不能 import Node 脚本），
// src/main/vault-watcher.js 的 normalizeId 与 extract-data.js 也完全一致。
// 三处实现必须保持一致 —— scripts/tests/cases/test_40_draft_id_continuity.py 的
// sub_impl_drift_check 用例会直接读盘比对三份源码，改一处而漏改其它会立刻测试失败。
//
// 语义：
//   '[[青崖城]]' → '青崖城'
//   'New City'   → 'new_city'      （空白与路径分隔符 → 下划线）
//   '青崖城·东'  → '青崖城东'      （非法字符剔除；\w 保留字母数字下划线）
//   空值          → 'unknown'

export function normalizeId(name) {
  if (!name) return 'unknown';
  return name.replace(/\[\[|\]\]/g, '').replace(/[\\\/\s]/g, '_').replace(/[^\w一-鿿]/g, '').toLowerCase();
}

/**
 * 取路径的文件名主干（去目录、去扩展名）。
 *
 * 为什么需要：主进程 create-obsidian-note 返回的是 vault 相对路径
 * （如 `03 设定/02 场景地点/青崖城.md`），而转正要用的新 id 来自**文件名主干**。
 * 主进程现已同时返回 filename 字段，本函数作为兜底（旧版主进程/第三方调用）。
 */
export function basenameNoExt(p) {
  if (!p) return '';
  const seg = String(p).split(/[\\/]/).pop() || '';
  return seg.replace(/\.md$/i, '');
}

/**
 * 由「笔记名 / 笔记路径」推导节点 id —— 转正流程的统一入口。
 * @param {{ filename?: string, path?: string }} result 主进程 create-obsidian-note 的返回值
 * @param {string} [fallbackName] 兜底名称（通常为节点自身 name）
 * @returns {string} 规范化后的 id（空输入返回 'unknown'）
 */
export function nodeIdFromNoteResult(result, fallbackName = '') {
  const raw = (result && (result.filename || basenameNoExt(result.path))) || fallbackName || '';
  return normalizeId(raw);
}
