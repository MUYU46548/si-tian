// utils/riverWeldCache.js — 汇流焊接结果的**单版缓存**（2026-11-08，纯函数，Node 可测）
//
// 为什么要有这一层（卡「汇流焊接仍是逐帧重算」）：
//   `interaction/rivers.js#strokeRiverNetworkAsPaths` 里那三遍 —— Catmull-Rom 细分（默认 ×6）、
//   `snapRiverTails`、`weldRiverJunctions` —— 以前是**每帧**都跑的，而河网几何**与相机无关**：
//   `autoRiverPartsFor()` 已经按“河网 / 地形 / 段流量上界”缓存成同一份数组，几何没变时它返回
//   **同一个引用**。于是“几何变了没有”有一个现成的身份判据：**数组引用 + subdiv**。
//   自建地形推演出 2457 条河 / 18,644 段（细分后 11 万段）时，这一遍单帧就要跑几十秒 ——
//   预算线（`WELD_SEG_BUDGET`）只能保证“不卡死”，保证不了“够快”，因为它每帧都在重算。
//
// 口径（三条）：
//   ① **只缓存一份**（最近一次）。河网通常只有一版；多份缓存只会把内存留给再也用不到的几何，
//      也会让“到底用的哪一版”变得难以解释。
//   ② **命中条件必须是身份**（引用相等），不是“看起来一样”：deep compare 11 万点比分比焊接还贵。
//   ③ **数量也要对得上**：同一份 `paths` 被就地改过（push/splice）时引用不变，但点数变了 ——
//      这时必须判失效，否则会拿上一版曲线去画新一版的河（错位比慢更糟）。
//
// 失效条件（显式）：河网换引用 / `subdiv` 变 / 曲线条数与本次 jobs 数不等 / 第一次。

/**
 * 新建一份空缓存。一个渲染器实例持有**一个**（`interaction/rivers.js` 模块级常量）。
 * @returns {{paths: any[]|null, subdiv: number|null, curves: any[][]|null,
 *            segs: number, welded: boolean, skipped: boolean, hits: number, misses: number}}
 */
export function createWeldCache() {
  return {
    paths: null,
    subdiv: null,
    curves: null,
    segs: 0,
    welded: false,
    skipped: false,
    hits: 0,
    misses: 0,
  };
}

/**
 * 读缓存。命中返回**那一版记录**（含 curve / segs / welded / skipped），未命中返回 null。
 *
 * @param {object} cache `createWeldCache()` 的产物
 * @param {{paths:any[], subdiv:number, count:number}} key
 *   `count` = 本帧要做几条曲线（少了/多了都算失效）
 * @returns {{curves:any[][], segs:number, welded:boolean, skipped:boolean}|null}
 */
export function readWeldCache(cache, key) {
  if (!cache || typeof cache !== 'object') return null;
  const { paths, subdiv, count } = key || {};
  const ok = !!paths
    && cache.paths === paths
    && cache.subdiv === subdiv
    && Array.isArray(cache.curves)
    && cache.curves.length === count;
  if (!ok) {
    cache.misses += 1;
    return null;
  }
  cache.hits += 1;
  return { curves: cache.curves, segs: cache.segs, welded: cache.welded, skipped: cache.skipped };
}

/**
 * 写缓存（覆盖上一版）。`curves` 必须是**本帧真正要画的那批**（焊接之后的），
 * 因为下游只读它；缓存里存的数组不会被本模块改动。
 *
 * @param {object} cache
 * @param {{paths:any[], subdiv:number, curves:any[][], segs:number,
 *          welded:boolean, skipped:boolean}} entry
 */
export function writeWeldCache(cache, entry) {
  if (!cache || typeof cache !== 'object' || !entry) return;
  cache.paths = entry.paths || null;
  cache.subdiv = Number.isFinite(entry.subdiv) ? entry.subdiv : null;
  cache.curves = Array.isArray(entry.curves) ? entry.curves : null;
  cache.segs = Number.isFinite(entry.segs) ? entry.segs : 0;
  cache.welded = !!entry.welded;
  cache.skipped = !!entry.skipped;
}

/** 排障口 / 用例读数：命中与失效各几次、当前缓存的是哪一版（不含几何正文） */
export function weldCacheStats(cache) {
  if (!cache || typeof cache !== 'object') return { hits: 0, misses: 0, cached: false, paths: 0, subdiv: null };
  return {
    hits: cache.hits,
    misses: cache.misses,
    cached: Array.isArray(cache.curves),
    paths: Array.isArray(cache.paths) ? cache.paths.length : 0,
    subdiv: cache.subdiv,
  };
}
