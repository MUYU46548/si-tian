// utils/fmg/rng.js — FMG 管线的**显式随机流**（B 阶段 2 的 P0 改造，2026-10-29）
//
// ── 改的是什么 ────────────────────────────────────────────────────────────────
// 上游（SP-1025 `planet-map/src/core`）沿用 Azgaar 的老机制：生成前 `Math.random = Alea(seed)`
// 把全局流换掉，于是"同 seed 可复现"依赖**全局副作用**。这条在司天里不能留：
//   · 同一页面里还有别的生成器（造陆 / Voronoi 铺底 / 地形推演）在用 `Math.random`，
//     全局替换会让它们互相污染，且"谁先跑"决定结果；
//   · worker 化之后全局流是并发的，不可复现；
//   · 单元测试里 `Math.random` 一被改，其它用例的结果就跟着变。
// 现在所有随机都从**显式传入的 `rng`** 来（本文件把上游那些 `Math.random()` 用法收成几个小函数）。
//
// ⚠️ 随机数算法复用 `utils/voronoiBatch.makeRng`（mulberry32）—— 仓里已经有这一份 PRNG，
//    不再引 `alea` 造第二个（"同一能力只许一份实现"）。

import { makeRng } from '../voronoiBatch';

/** 种子规范化：字符串也能当种子（hash 成 32 位），NaN/空 → 1 */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.abs(Math.floor(seed)) >>> 0 || 1;
  const s = String(seed == null ? '' : seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) || 1;
}

/**
 * 显式随机流。方法名与上游用法一一对应：
 *   · `next()`        —— 上游的裸 `Math.random()`
 *   · `range(min,max)`—— `Math.random() * span + min`（**不取整**）
 *   · `int(min,max)`  —— 上游 `rand(min, max)`（闭区间整数）
 *   · `chance(p)`     —— 上游 `P(p)`
 */
export function createFmgRandom(seed) {
  const rng = makeRng(normalizeSeed(seed));
  return {
    next: rng,
    range(min, max) {
      return min + (max - min) * rng();
    },
    int(min, max) {
      return Math.floor(rng() * (max - min + 1)) + min;
    },
    chance(p) {
      if (p >= 1) return true;
      if (p <= 0) return false;
      return rng() < p;
    },
  };
}

/** 上游 `getNumberInRange`：`"1-3"` / `"2"` / `"0.5"` / `"-2-4"` → 随机数 */
export function numberInRange(r, rng) {
  if (typeof r !== 'string') return 0;
  if (!Number.isNaN(+r)) {
    const base = Math.trunc(+r);
    return base + (rng.chance(+r - base) ? 1 : 0);
  }
  let spec = r;
  const sign = spec[0] === '-' ? -1 : 1;
  if (Number.isNaN(+spec[0])) spec = spec.slice(1);
  const range = spec.includes('-') ? spec.split('-') : null;
  if (!range) return 0;
  const count = rng.int(parseFloat(range[0]) * sign, +parseFloat(range[1]));
  if (Number.isNaN(count) || count < 0) return 0;
  return count;
}

export const clampHeight = (v) => (v < 0 ? 0 : v > 100 ? 100 : v);
