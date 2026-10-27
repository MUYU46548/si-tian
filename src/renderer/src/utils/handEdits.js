// utils/handEdits.js — 地形特征级锁定（纯函数；2026-10-27，移植自 SP-1025）
//
// ── 为什么按坐标而不是按格下标 ────────────────────────────────────────────────
// 高度图重生成后 `grid.points` 会重建（分辨率/原点/种子都可能变），**下标全变**。
// 但同一个世界坐标仍然是同一块地 —— 所以手绘登记用 `x,y` 的量化键，重生成时按坐标写回。
// 换 seed = 全新世界：坐标仍然对得上，但语义上不该保留（调用方用 `genSeed` 判断后丢弃）。
//
// ── 条目形状 ────────────────────────────────────────────────────────────────
// `{ x, y, h }`：世界坐标 + 手绘高度。数组可直接进 `.sitian`（JSON），不需要 TypedArray。
//
// 纯函数：不碰 Vue / DOM / store；Node 侧直接测（`unit/test_hand_edits.js`）。

/** 坐标量化键：1e-2 精度（FMG 网格 spacing 通常 ≥7，远大于此） */
export function handEditKey(x, y) {
  return `${Math.round(Number(x) * 100) / 100},${Math.round(Number(y) * 100) / 100}`;
}

/** 合并旧登记 + 本笔触及格（同坐标后者覆盖）；脏条目丢弃 */
export function mergeHandEdits(oldEdits, touched) {
  const map = new Map();
  for (const e of (Array.isArray(oldEdits) ? oldEdits : [])) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.h)) continue;
    map.set(handEditKey(e.x, e.y), { x: e.x, y: e.y, h: e.h });
  }
  for (const e of (Array.isArray(touched) ? touched : [])) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.h)) continue;
    map.set(handEditKey(e.x, e.y), { x: e.x, y: e.y, h: e.h });
  }
  return [...map.values()];
}

function pointXY(p) {
  return Array.isArray(p) ? [p[0], p[1]] : [p && p.x, p && p.y];
}

/** 旧图上**仍然有效**的手绘：当前 h 与登记值一致才保留（撤销/改回过的自然出局） */
export function activeHandEdits(hm) {
  const edits = Array.isArray(hm && hm.handEdits) ? hm.handEdits : [];
  const pts = hm && hm.grid && Array.isArray(hm.grid.points) ? hm.grid.points : null;
  if (!edits.length || !pts || !hm.h || hm.h.length !== pts.length) return [];
  const byKey = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pointXY(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byKey.set(handEditKey(x, y), i);
  }
  const out = [];
  for (const e of edits) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const i = byKey.get(handEditKey(e.x, e.y));
    if (i === undefined) continue;
    if (Math.abs(Number(hm.h[i]) - Number(e.h)) > 0.01) continue;
    out.push({ x: e.x, y: e.y, h: Number(hm.h[i]) });
  }
  return out;
}

/**
 * 把旧图手绘按坐标写回新高度图。
 * 同 seed + 同布局 → 坐标逐点匹配；分辨率/原点变了 → 匹配不上的如实丢弃。
 * @returns {{applied:number, kept:Array}} 实际写回数与保留条目
 */
export function reapplyHandEdits(nextHm, edits) {
  const pts = nextHm && nextHm.grid && Array.isArray(nextHm.grid.points) ? nextHm.grid.points : null;
  if (!pts || !nextHm.h || nextHm.h.length !== pts.length || !Array.isArray(edits) || !edits.length) {
    return { applied: 0, kept: [] };
  }
  const byKey = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pointXY(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byKey.set(handEditKey(x, y), i);
  }
  const kept = [];
  for (const e of edits) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.h)) continue;
    const i = byKey.get(handEditKey(e.x, e.y));
    if (i === undefined) continue;
    nextHm.h[i] = e.h;
    kept.push({ x: e.x, y: e.y, h: e.h });
  }
  return { applied: kept.length, kept };
}
