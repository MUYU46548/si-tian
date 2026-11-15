// interior/floorHoles.js — 楼板洞口的合并口径（纯函数，2026-11-15，A16 余）
//
// ── 为什么单独一层 ────────────────────────────────────────────────────────
// 楼板上的洞有两个来源：
//   ① **楼梯自动开**（`stairs.js#stairHolesForFloor`：下层上行梯 / 本层下行梯）；
//   ② **用户手画**（检修口、挑空、中庭 —— 这一版才加）。
// 3D 切楼板（`buildShell`）、2D 虚线框（`renderFloor.drawFloorHoles`）、出图三处都要
// **同一份洞列表**；谁自己拼一遍，就会出现“平面图上有洞、3D 里楼板是整块”这种对不上的图。
// 所以合并只在这里做一次。
//
// ── 数据口径 ──────────────────────────────────────────────────────────────
//   `floor.holes = [{ id, x, y, w, h }]`
//     x, y —— 矩形**左上角**（cm，平面坐标，与家具同一口径）
//     w, h —— 洞的宽高（cm），夹在 20~5000（小于 20cm 的洞在图上是一个点，切楼板也切不动）
//
// 为什么先只做矩形：检修口 / 挑空 / 中庭在建筑图里基本都是矩形，矩形还能直接复用
// `slabBoxes` 的矩形差集（斜的、圆的多边形要另写差集算法，那是另一个命题）。
//
// 纯函数：不 import three / 不碰 DOM / 不碰 store，Node 直接测（`unit/test_floor_holes.js`）。

import { stairHolesForFloor } from './stairs.js';

/** 手画洞口的缺省尺寸（cm）与上下限 */
export const HOLE_DEFAULTS = Object.freeze({ w: 120, h: 120 });
export const HOLE_MIN = 20;
export const HOLE_MAX = 5000;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 把一条手画洞口夹到合法范围。
 * @param {object} hole { x, y, w, h }
 * @returns {{x:number,y:number,w:number,h:number}|null} 坐标不成立时 null
 */
export function normalizeHole(hole) {
  if (!hole || typeof hole !== 'object') return null;
  const x = Number(hole.x);
  const y = Number(hole.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = clamp(num(hole.w, HOLE_DEFAULTS.w) || HOLE_DEFAULTS.w, HOLE_MIN, HOLE_MAX);
  const h = clamp(num(hole.h, HOLE_DEFAULTS.h) || HOLE_DEFAULTS.h, HOLE_MIN, HOLE_MAX);
  return { x, y, w, h };
}

/**
 * 洞口矩形 → 多边形（左上 → 右上 → 右下 → 左下，顺时针）。
 * @param {object} hole
 * @returns {Array<{x:number,y:number}>}
 */
export function holePolygon(hole) {
  const n = normalizeHole(hole);
  if (!n) return [];
  return [
    { x: n.x, y: n.y },
    { x: n.x + n.w, y: n.y },
    { x: n.x + n.w, y: n.y + n.h },
    { x: n.x, y: n.y + n.h },
  ];
}

/**
 * 本层**手画**的洞口（与楼梯洞同一种形状：`{ holeId, label, poly }`）。
 * @param {object} floor
 * @returns {Array<{holeId:string, label:string, poly:Array}>}
 */
export function ownHolesForFloor(floor) {
  const list = Array.isArray(floor && floor.holes) ? floor.holes : [];
  const out = [];
  for (const hole of list) {
    const poly = holePolygon(hole);
    if (poly.length < 3) continue;
    out.push({
      holeId: String(hole.id || ''),
      label: String(hole.label || '洞口'),
      poly,
    });
  }
  return out;
}

/**
 * 本层楼板上**全部**洞口：楼梯自动开的 + 用户手画的（顺序：楼梯在前，手画在后）。
 *
 * @param {Array} floors 全部楼层
 * @param {string} floorId 本层 id
 * @returns {Array} 与 `stairHolesForFloor` 同形状（`{ poly, ... }`），手画的多两个字段 `holeId` / `label`
 */
export function allHolesForFloor(floors, floorId) {
  const list = Array.isArray(floors) ? floors : [];
  const floor = list.find((f) => f && f.id === floorId) || null;
  const stair = stairHolesForFloor(list, floorId);
  const own = floor ? ownHolesForFloor(floor) : [];
  return [...stair, ...own];
}

/**
 * 命中检测：点落在哪个**手画**洞口里（取最小的那个，重叠时优先选小的 —— 大洞套小洞时用户想选小的）。
 *
 * @param {Array} holes 手画洞数组（`floor.holes`）
 * @param {{x:number,y:number}} p
 * @returns {object|null}
 */
export function holeAtPoint(holes, p) {
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
  let best = null;
  let bestArea = Infinity;
  const list = Array.isArray(holes) ? holes : [];
  for (const hole of list) {
    const n = normalizeHole(hole);
    if (!n) continue;
    if (p.x < n.x || p.x > n.x + n.w || p.y < n.y || p.y > n.y + n.h) continue;
    const area = n.w * n.h;
    if (area < bestArea) { bestArea = area; best = hole; }
  }
  return best;
}
