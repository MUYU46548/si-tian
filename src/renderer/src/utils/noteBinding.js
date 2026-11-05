// utils/noteBinding.js — 「标记 / 剧本 ↔ 资料笔记」绑定的**纯函数层**（B1，2026-11-05）
//
// 为什么单独一层：绑定只存一个**库内相对路径**（`notePath`），所有判断都是纯字符串/集合操作 ——
//   归一化（Windows 反斜杠、`./` 前缀）、显示名、以及「这篇笔记还在不在」。
//   放到组件里判 = 省份面板/标记面板/剧本表单各判一次，**三份实现迟早不一致**（本仓红线）。
//
// 与既有两套"笔记"能力的边界（别混，也不合并）：
//   · `node.lore`（loreBinding.js）= **实体主词条**，带稳定身份快照与改名对账；
//   · `node.notePaths` = 实体的**补充资料**，可挂多篇，只存路径；
//   · 本文件的 `notePath` = **标记 / 剧本**上的一篇笔记（单个路径）。三者用途不同，不互相替代。
//
// 只读、确定性、不碰 DOM —— 可直接 Node 单测（`scripts/tests/unit/test_note_binding.js`）。

/**
 * 把用户/索引给的路径归一成"库内相对路径"的**唯一写法**。
 * - 反斜杠 → 正斜杠（Windows 上 Obsidian 与索引两边写法都会出现）；
 * - 去掉开头的 `./`（重复的也去掉）；
 * - 去掉首尾空白；空值 → 空串（表示"没绑定"）。
 * @param {*} raw
 * @returns {string}
 */
export function normalizeNotePath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  if (!p) return '';
  p = p.replace(/\\/g, '/');
  // 只剥掉路径开头的 `./`（`..` 不许剥：那会静默改掉语义；越界路径由主进程守卫拒绝）
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  return p;
}

/** 显示名：路径最后一段去掉 `.md`（UI 上不必让人读整条路径） */
export function noteBasename(notePath) {
  const p = normalizeNotePath(notePath);
  if (!p) return '';
  const cut = p.lastIndexOf('/');
  const base = cut === -1 ? p : p.slice(cut + 1);
  return base.replace(/\.md$/i, '');
}

/**
 * 绑定状态（面板据此决定显示什么）。
 * `unbound` = 没绑；`bound` = 绑着且库里有这篇；`dangling` = 绑着但库里找不到（改名/移动/删除）。
 *
 * @param {string} notePath 标记/剧本上的 `notePath`
 * @param {Array<string|{path?:string,sourcePath?:string}>|Set<string>|null} knownPaths
 *        库里的笔记清单（`listVaultNotes()` 的 notes / 路径数组 / Set 都行）。
 *        **传 `null` / `undefined` = 还没取到清单**，此时只判 unbound（不许武断说"找不到了"）。
 * @returns {{state:'unbound'|'bound'|'dangling', path:string, name:string}}
 */
export function noteLinkState(notePath, knownPaths) {
  const path = normalizeNotePath(notePath);
  const name = noteBasename(path);
  if (!path) return { state: 'unbound', path: '', name: '' };
  if (knownPaths == null) return { state: 'bound', path, name };
  const set = knownPaths instanceof Set ? knownPaths : new Set(
    Array.from(knownPaths || []).map((x) => normalizeNotePath(
      x && typeof x === 'object' ? (x.path || x.sourcePath || '') : x,
    )),
  );
  return { state: set.has(path) ? 'bound' : 'dangling', path, name };
}

/**
 * 从 `listVaultNotes()` 的结果里取"给 noteLinkState 用的清单"。
 * 读不到（API 不可用 / 未设库）→ `null`，**不是空数组**：空数组会让所有绑定都显示成"找不到了"。
 * @param {{success?:boolean, notes?:Array}} res
 * @returns {Array<object>|null}
 */
export function knownNotesFrom(res) {
  if (!res || res.success !== true || !Array.isArray(res.notes)) return null;
  return res.notes;
}

/**
 * 从 `vault-index-paths` 的结果里取路径清单（**B1 用的就是这一条**）。
 *
 * 为什么不用 `listVaultNotes()`：那条只列“扫描范围内的地图笔记”（断线对账口径），
 * 而标记/剧本绑的是**任意资料笔记** —— 用错清单会把绑得好好的笔记误报成“找不到了”
 * （2026-11-05 真机第一跑就是这么红的：`地理/北境/风岬港.md` 不在扫描范围内）。
 * 读不到 → `null`（同一条“不许武断说找不到”的纪律）。
 * @param {{success?:boolean, paths?:Array<string>}} res
 * @returns {Array<string>|null}
 */
export function knownPathsFrom(res) {
  if (!res || res.success !== true || !Array.isArray(res.paths)) return null;
  return res.paths;
}
