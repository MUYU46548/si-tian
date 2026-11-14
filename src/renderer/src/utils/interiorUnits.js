// utils/interiorUnits.js — 建筑内部图的尺度口径（纯函数，2026-11-13）
//
// ── 为什么要单独一层 ──────────────────────────────────────────────────────
// 同一套编辑器要画 8×6 米茅屋，也要画 300×200 米宫殿（差 37 倍）。所有"看起来对"
// 的东西（网格、字号、家具可见性、比例尺、面积）都必须由**同一个口径**推出来，
// 否则宫殿里画得好好的图，到茅屋里全错 —— 而用户看不出为什么。
//
// ── 口径 ─────────────────────────────────────────────────────────────────
//   · 世界单位 = **厘米**。1 世界单位 = 1cm，全项目统一（见 docs/plan/INTERIOR_COPYPLAN §十一）。
//   · `zoom` = 屏幕像素 / 厘米（px per cm）。相机只缩放这一件事。
//   · 面积对外显示**平方米**，长度对外显示**米**（< 1m 显示厘米）。
//
// ── 极差怎么办 ───────────────────────────────────────────────────────────
// 不靠"把家具画小"：家具屏幕最小边 < 6px 就整类不画（`isFurnitureVisible`）。
// 宫殿缩到整栋可见时，家具自动消失，只剩墙与房间 —— 和 EU4"缩小时只留势力名"同一纪律。
//
// 纯函数：不碰 DOM / store，Node 直接测（`unit/test_interior_units.js`）。

/** 墙默认厚 12cm（半砖墙），高 280cm（住宅净高） */
export const DEFAULT_WALL_THICKNESS = 12;
export const DEFAULT_WALL_HEIGHT = 280;
/** 层高默认 300cm（多层建筑叠层用） */
export const DEFAULT_FLOOR_HEIGHT = 300;
/** 家具屏幕最小边低于这个像素就整类不画 */
export const MIN_FURNITURE_PX = 6;

/** 网格候选（cm），由密到疏 */
export const GRID_STEPS_CM = Object.freeze([10, 25, 50, 100, 500, 1000, 5000]);

/**
 * 让整栋建筑铺满视口所需的缩放（px per cm）。
 * @param {{w:number,h:number}} footprint 建筑平面尺寸（cm）
 * @param {{w:number,h:number}} viewport  视口（CSS 像素）
 * @param {number} [padding=0.9] 四周留白比例
 */
export function fitZoom(footprint, viewport, padding = 0.9) {
  const fw = Number(footprint && footprint.w);
  const fh = Number(footprint && footprint.h);
  const vw = Number(viewport && viewport.w);
  const vh = Number(viewport && viewport.h);
  if (!(fw > 0) || !(fh > 0) || !(vw > 0) || !(vh > 0)) return 1;
  const k = Number.isFinite(padding) && padding > 0 && padding <= 1 ? padding : 0.9;
  return Math.min(vw / fw, vh / fh) * k;
}

/**
 * 选一档网格：屏幕上每格 **不小于 minPx** 的最密那一档。
 * 都太密就用最疏的那档（不再往上加，否则宫殿里会画出一条看不见的线）。
 *
 * @param {number} zoom px per cm
 * @param {number} [minPx=8] 一格至少多少屏幕像素
 * @returns {number} 格子边长（cm）
 */
export function pickGridStep(zoom, minPx = 8) {
  const z = Number(zoom);
  const min = Number.isFinite(minPx) && minPx > 0 ? minPx : 8;
  if (!(z > 0)) return GRID_STEPS_CM[GRID_STEPS_CM.length - 1];
  for (const step of GRID_STEPS_CM) {
    if (step * z >= min) return step;
  }
  return GRID_STEPS_CM[GRID_STEPS_CM.length - 1];
}

/**
 * 长度显示：< 100cm 用厘米（整数），否则用米（两位小数）。
 * 例：45 → "45 cm"；360 → "3.60 m"；12000 → "120.00 m"
 */
export function formatLength(cm) {
  const v = Number(cm);
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) < 100) return `${Math.round(v)} cm`;
  return `${(v / 100).toFixed(2)} m`;
}

/**
 * 面积显示：平方厘米 → 平方米（两位小数）。
 * 例：48000 → "4.80 ㎡"
 */
export function formatArea(cm2) {
  const v = Number(cm2);
  if (!Number.isFinite(v) || v < 0) return '';
  return `${(v / 10000).toFixed(2)} ㎡`;
}

/**
 * 家具在当前缩放下是否还值得画。
 *
 * 判据 = **屏幕最小边 ≥ 6px**。不按缩放阈值硬编码 —— 宫殿与茅屋用同一套判据自动分档，
 * 茅屋的床 200cm 在铺满视口时约 40px（画），宫殿的床在铺满时约 1px（不画）。
 *
 * @param {{width?:number,height?:number}} item 家具（cm）
 * @param {number} zoom px per cm
 * @param {number} [minPx=MIN_FURNITURE_PX]
 */
export function isFurnitureVisible(item, zoom, minPx = MIN_FURNITURE_PX) {
  const w = Number(item && item.width);
  const h = Number(item && item.height);
  const z = Number(zoom);
  if (!(z > 0)) return false;
  if (!(w > 0) && !(h > 0)) return false;
  const min = Number.isFinite(minPx) && minPx > 0 ? minPx : MIN_FURNITURE_PX;
  const side = Math.min(w > 0 ? w : Infinity, h > 0 ? h : Infinity);
  if (!Number.isFinite(side)) return false;
  return side * z >= min;
}

/**
 * 家具在屏幕上的像素尺寸（给"最小可见尺寸兜底"用：真实太小但用户就想看见时，
 * 可以画成不小于 npx 的块，而不是消失）。
 */
export function furnitureScreenSize(item, zoom) {
  const z = Number(zoom) || 0;
  return {
    w: Math.max(0, (Number(item && item.width) || 0) * z),
    h: Math.max(0, (Number(item && item.height) || 0) * z),
  };
}
