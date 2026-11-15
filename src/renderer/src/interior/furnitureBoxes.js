// interior/furnitureBoxes.js — 家具 → 3D 体块（纯函数，2026-11-15，A20）
//
// ── 这一层干什么 ──────────────────────────────────────────────────────────
// `buildShell.js` 把墙/门窗/楼板/楼梯变成方盒，但**家具一直是空的**：轴测出图里
// 房间是彻底空的（`build/axonometric/` 那三张图就是，墙内什么都没有）。
// 家具在平面图上只有“俯视符号”，3D 里必须由**同一份数据**推出一块体积，
// 否则又要多一份“3D 专用家具数据”，两份迟早对不上（同“同一能力只许一份实现”）。
//
// ── 口径 ──────────────────────────────────────────────────────────────────
//   · 世界单位 = 厘米（与 `utils/interiorUnits.js` / `buildShell.js` 同一口径）。
//   · 平面 (x, y) 是**左上角**、`width × height` 是平面尺寸 —— 与 `InteriorView` 的
//     `drawFurniture` 完全一致（那里 `translate(item.x + width/2, item.y + height/2)`）。
//     所以这里中心点 = (x + w/2, y + d/2)，三维里 cx 照抄、cz = 平面 y。
//   · 高度（cm）不由用户填，按**家具类型查表**：一张床 45、一张桌子 75、一个柜子 180…
//     家具数据里只有二维尺寸，高度是类型的属性（用户改不了，也不需要改）。
//
// ── 旋转方向（最容易写反的一处）────────────────────────────────────────────
//   平面图的 `rotation` 是**顺时针**（canvas 的 y 轴向下）；three 的 `rotation.y` 从 +y 往下看
//   是**逆时针**。二者相差一个负号：`rotY = -rotation°`。写反了不会报错，
//   只会让所有家具在 3D 里镜像 —— 床头顶到墙里，而平面图看着完全正常。
//
// ── 哪些不进 3D（刻意的）──────────────────────────────────────────────────
//   · `door` / `window`：它们是**墙上的开口**，已经由 `wallBoxes` 按洞口挖掉了；
//     再立一层门板/玻璃就会挡住自己，还会和墙里的填充色块打架。
//   · 院落 / 园林 / 走廊 / 水池 / 围墙（`isArea` 那一组）：它们是**地面区域**，
//     不是家具体块。走廊和水池要进 3D 得另做一层（地面材质），不能塞进盒子列表。
//
// 纯函数：不 import three / 不碰 DOM / 不碰 store，Node 直接测（`unit/test_furniture_boxes.js`）。

/** 家具类型 → 高度（cm）。没有一条是拍脑袋的：按常见家具的**台面/坐面**高度取。 */
export const FURNITURE_HEIGHTS = Object.freeze({
  generic: 70,      // 认不出的东西：一张矮几
  table: 75,        // 餐桌 / 书桌的台面高
  chair: 45,        // 坐面高（靠背不计：体块只表达到坐面）
  bed: 45,          // 床面高（双人床垫顶面）
  chest: 180,       // 书柜 / 货架
  wardrobe: 200,    // 衣柜（顶到门框上方）
  sofa: 80,         // 坐面 + 靠垫，比椅子高一点
  decoration: 40,   // 花瓶 / 摆件
});

/** 表里没有的类型按这个高度（cm） */
export const DEFAULT_FURNITURE_HEIGHT = 70;

/** 家具缺省色（`item.color` 不是合法十六进制时用它） */
export const DEFAULT_FURNITURE_COLOR = '#a89880';

const AREA_TYPES = new Set(['courtyard', 'garden', 'corridor', 'pond', 'wall']);
const WALL_OPENING_TYPES = new Set(['door', 'window']);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 某类家具的高度（cm）。
 * @param {string} type 家具类型（`table` / `bed` / …）
 * @returns {number}
 */
export function furnitureHeight(type) {
  const t = String(type || 'generic');
  const h = FURNITURE_HEIGHTS[t];
  return Number.isFinite(h) ? h : DEFAULT_FURNITURE_HEIGHT;
}

/**
 * 这件家具是否该变成一个 3D 体块。
 * @param {object} item 家具数据
 * @returns {boolean}
 */
export function isFurnitureBody(item) {
  if (!item || typeof item !== 'object') return false;
  const type = String(item.type || 'generic');
  if (AREA_TYPES.has(type) || WALL_OPENING_TYPES.has(type)) return false;
  const w = num(item.width);
  const d = num(item.height);
  return w > 0 && d > 0;
}

/**
 * 一层楼的家具 → 方盒列表（与 `buildShell` 的墙/楼板同一种形状）。
 *
 * @param {Array} items 家具数组（`floor.furniture`）
 * @param {number} elevation 本层离地高度（cm）
 * @param {object} [opts] { color } —— 缺省色
 * @returns {Array<{kind:string, furnitureType:string, color:string, cx:number, cy:number, cz:number, sx:number, sy:number, sz:number, rotY:number}>}
 */
export function furnitureBoxes(items, elevation, opts = {}) {
  const base = num(elevation, 0);
  const fallbackColor = HEX_COLOR.test(String(opts.color || '')) ? opts.color : DEFAULT_FURNITURE_COLOR;
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isFurnitureBody(item)) continue;
    const type = String(item.type || 'generic');
    const w = num(item.width);
    const d = num(item.height);
    const h = furnitureHeight(type);
    const color = HEX_COLOR.test(String(item.color || '')) ? item.color : fallbackColor;
    out.push({
      kind: 'furniture',
      furnitureType: type,
      color,
      cx: num(item.x) + w / 2,
      cy: base + h / 2,
      cz: num(item.y) + d / 2,
      sx: w,
      sy: h,
      sz: d,
      // 平面顺时针 → 三维绕 +y 逆时针：差一个负号（见文件头）
      rotY: -(num(item.rotation) * Math.PI) / 180,
    });
  }
  return out;
}
