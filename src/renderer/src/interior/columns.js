// interior/columns.js — 柱（Column）的几何与命中（纯函数，2026-11-15，A24 余）
//
// ── 柱是什么（数据口径）────────────────────────────────────────────────────
// 一根柱 = 平面上的**一个点 + 一个截面**，竖直从本层地面长到本层墙顶：
//
//   { id, x, y, size, shape, color }
//     x, y  —— 柱**中心**（cm，平面坐标；注意与家具的“左上角”口径不同，柱是中心对称的）
//     size  —— 截面边长（cm），默认 40（结构柱常见 400×400 或 240×240）
//     shape —— 'square'（默认）/ 'round'（见下面“圆柱”）
//     color —— 平面填充色，默认浅石色
//
// 为什么柱没有 `height`：柱的高度是**本层净高**（墙顶标高），不是用户每根去填的数字。
// 让用户填高度只会得到一堆“看起来对、3D 里顶不到梁”的柱子。
//
// ── 圆柱（刻意没做）──────────────────────────────────────────────────────
// 数据层允许 `shape: 'round'`（老数据/将来用），但这一版**渲染一律按方柱**：
// 3D 那边 `axoScene` 的体块只有 BoxGeometry（圆柱要另起几何 + 实时预览的 InstancedMesh
// 也要分桶），2D 画圆而 3D 画方会让“图和模型对不上”。等圆柱几何真做了再开这个开关，
// 现在宁可少一个形状，也不要两个视图各说各话。
//
// 纯函数：不 import three / 不碰 DOM / 不碰 store，Node 直接测（`unit/test_columns.js`）。

/** 柱的缺省值（cm） */
export const COLUMN_DEFAULTS = Object.freeze({
  size: 40,
  shape: 'square',
  color: '#9a8f7d',
});

/** 截面边长下限/上限（cm）：小于 15cm 在图上是一个点，大于 200cm 那是墙墩不是柱 */
export const COLUMN_SIZE_MIN = 15;
export const COLUMN_SIZE_MAX = 200;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 把一根柱的数值夹到合法范围（写口与渲染共用同一口径）。
 * @param {object} col
 * @returns {{size:number, shape:string, color:string}|null} 数据不成立时 null
 */
export function normalizeColumn(col) {
  if (!col || typeof col !== 'object') return null;
  const x = Number(col.x);
  const y = Number(col.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const raw = num(col.size, COLUMN_DEFAULTS.size);
  const size = Math.min(COLUMN_SIZE_MAX, Math.max(COLUMN_SIZE_MIN, raw || COLUMN_DEFAULTS.size));
  const shape = col.shape === 'round' ? 'round' : 'square';
  const color = HEX_COLOR.test(String(col.color || '')) ? col.color : COLUMN_DEFAULTS.color;
  return { size, shape, color };
}

/**
 * 一层楼的柱 → 方盒列表（与 `buildShell` 的墙/楼板同一种形状，直接拼进 boxes）。
 *
 * @param {Array} columns 柱数组（`floor.columns`）
 * @param {number} elevation 本层离地高度（cm）
 * @param {object} [opts] { wallHeight } —— 本层墙顶标高（相对本层地面），缺省 280
 * @returns {Array<{kind:string, color:string, cx:number, cy:number, cz:number, sx:number, sy:number, sz:number, rotY:number}>}
 */
export function columnBoxes(columns, elevation, opts = {}) {
  const base = num(elevation, 0);
  const wallHeight = num(opts.wallHeight, 280) > 0 ? num(opts.wallHeight, 280) : 280;
  const out = [];
  for (const col of Array.isArray(columns) ? columns : []) {
    const n = normalizeColumn(col);
    if (!n) continue;
    out.push({
      kind: 'column',
      color: n.color,
      cx: num(col.x),
      cy: base + wallHeight / 2,
      cz: num(col.y),
      sx: n.size,
      sy: wallHeight,
      sz: n.size,
      rotY: 0,
    });
  }
  return out;
}

/**
 * 一根柱的平面矩形（给命中检测、选择框、越界判断用）。
 * @param {object} col
 * @returns {{x:number,y:number,w:number,h:number}|null} 左上角 + 尺寸（cm）
 */
export function columnFootprint(col) {
  const n = normalizeColumn(col);
  if (!n) return null;
  return {
    x: num(col.x) - n.size / 2,
    y: num(col.y) - n.size / 2,
    w: n.size,
    h: n.size,
  };
}

/**
 * 命中检测：点 (p.x, p.y) 落在哪根柱上（取最近的一根）。
 *
 * @param {Array} columns
 * @param {{x:number,y:number}} p 世界坐标（cm）
 * @param {number} [slack=6] 额外容差（cm）—— 手指点不准时给一点余量
 * @returns {object|null}
 */
export function columnAtPoint(columns, p, slack = 6) {
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
  const tol = num(slack, 6);
  let best = null;
  let bestD = Infinity;
  for (const col of Array.isArray(columns) ? columns : []) {
    const fp = columnFootprint(col);
    if (!fp) continue;
    const dx = Math.max(fp.x - p.x, 0, p.x - (fp.x + fp.w));
    const dy = Math.max(fp.y - p.y, 0, p.y - (fp.y + fp.h));
    if (dx > tol || dy > tol) continue;
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = col; }
  }
  return best;
}
