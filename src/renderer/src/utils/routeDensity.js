// utils/routeDensity.js — 道路**分级渐显**（C5，2026-10-29；纯函数，Node 可测）
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
// 真实 `__real_desite.map` 有 **496 条**路/航路。旧实现只做了一次粗节流
// （`far`/`mid` 藏掉 trails 与 searoutes），到 `near` 档 496 条全上 —— 画面上是一张橙色的网，
// 省界与地形都被压住。用户的原话是「道路太密了」。
//
// ── 口径（与城镇/标签同一套档位，不另立阈值表）────────────────────────────────
// 档位来自 `utils/labelZoom.js` 的 `labelDetailNow()`（far → close 四档）：
//   far   ：只画主干（roads 里长度进前 50% 的那些）
//   mid   ：roads 全部
//   near  ：roads + trails
//   close ：roads + trails + searoutes
// 这样"越小越简"与标签/城镇完全同向 —— 用户滚一下滚轮，看到的详略变化是一致的。
//
// ⚠️ 不要用 `width` 当"主干"判据：FMG 导入的路几乎都是同一个线宽（0.9），按线宽过滤等于全留。
//    长度是唯一在真实数据上能分出主次的信号（长的一般是城际干道，短的常是村道）。

export const ROUTE_DETAIL_TIERS = Object.freeze(['far', 'mid', 'near', 'close']);

/** 档位 → 允许出现的分组（`r.group`；缺省按 roads 处理） */
export const ROUTE_TIER_GROUPS = Object.freeze({
  far: Object.freeze(['roads']),
  mid: Object.freeze(['roads']),
  near: Object.freeze(['roads', 'trails']),
  close: Object.freeze(['roads', 'trails', 'searoutes']),
});

/** `far` 档保留的干道比例（按长度取前 N） */
export const ROUTE_FAR_KEEP_SHARE = 0.5;

/**
 * 折线长度（世界单位；点数 < 2 视为 0）。
 * @param {Array<{x:number,y:number}>} points
 */
export function polylineLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!a || !b) continue;
    const dx = Number(b.x) - Number(a.x);
    const dy = Number(b.y) - Number(a.y);
    if (Number.isFinite(dx) && Number.isFinite(dy)) sum += Math.hypot(dx, dy);
  }
  return sum;
}

/**
 * `far` 档的"主干长度门槛"。返回 0 = 不过滤（不需要算）。
 * @param {Array<object>} routes
 * @param {string} detail
 * @param {number} [keepShare]
 */
export function arterialLengthThreshold(routes, detail, keepShare = ROUTE_FAR_KEEP_SHARE) {
  if (detail !== 'far') return 0;
  const lens = [];
  for (const r of routes || []) {
    if (!r || (r.group && r.group !== 'roads')) continue;
    const L = polylineLength(r.points);
    if (L > 0) lens.push(L);
  }
  if (lens.length < 2) return 0;
  lens.sort((a, b) => b - a);
  const keep = Math.max(1, Math.round(lens.length * Math.max(0.05, Math.min(1, keepShare))));
  return lens[Math.min(lens.length - 1, keep - 1)];
}

/**
 * 这一条路在当前档位要不要画。
 * @param {{group?:string, points?:Array}} route
 * @param {string} detail 档位（far/mid/near/close；未知档按 close 处理 = 宁可多画）
 * @param {number} [arterialLen] `arterialLengthThreshold()` 的返回值（0 = 不过滤）
 */
export function shouldDrawRoute(route, detail, arterialLen = 0) {
  if (!route || !Array.isArray(route.points) || route.points.length < 2) return false;
  const tier = ROUTE_TIER_GROUPS[detail] || ROUTE_TIER_GROUPS.close;
  const group = route.group || 'roads';
  if (!tier.includes(group)) return false;
  if (detail === 'far' && arterialLen > 0 && group === 'roads') {
    return polylineLength(route.points) >= arterialLen;
  }
  return true;
}
