// utils/gridSpatialIndex.js — 网格点的**桶式空间索引**（纯函数，Node 可测；2026-10-08）
//
// ── 为什么要有这一层 ─────────────────────────────────────────────────────────
// 高度图网格动辄 2~4 万格（真实库实测 26910 / 38718），而笔刷**每一次 mousemove** 都要问
// 「落点半径内有哪些格」。线性扫全表 = 每次 2~4 万次距离计算，几十次/秒 → 直接卡死主线程。
//
// 这套「按 spacing×2 分桶 → 只扫落点邻域桶」的写法此前已在 `usePlanetHeightBrush` 里
// 存在一份（那里是私有实现）。本模块把它抽成**纯函数**，供新的逐格通道笔刷
// （`store/geodataModules/channelBrush.js`）复用，避免同一条热路径长出第二套口径
// （口径漂移不会报错，只会让"吸管吸到的格"与"笔刷刷到的格"慢慢不是同一格）。
//
// ⚠️ 语义与 `usePlanetHeightBrush.getIndex/collectInRadius` **逐字一致**：
//    · 桶大小 = `spacing * 2`，键 = `` `${ci},${cj}` ``
//    · `collectInRadius` 返回的是**候选**（邻域桶内的全部下标），距离过滤由调用方做
//      —— 因为"命中半径"的语义各工具不同（画圆 / 方形 / 带 falloff）。

export const DEFAULT_SPACING = 14.4;

/** 取点坐标（兼容 `[x,y]` 与 `{x,y}` 两种历史形态） */
export function pointXY(p) {
  return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
}

/**
 * 建索引。只依赖 `grid.points` 与 `spacing`（**与高度值无关**）→ 可以在笔刷生命周期内缓存。
 * @returns {{spacing:number, cellSize:number, minX:number, minY:number, cellMap:Map<string,number[]>, count:number}|null}
 */
export function buildGridIndex(grid) {
  const pts = grid && grid.points;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const spacing = (grid.spacing || DEFAULT_SPACING);
  const cellSize = spacing * 2;

  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pointXY(pts[i]);
    if (px < minX) minX = px;
    if (py < minY) minY = py;
  }

  const cellMap = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pointXY(pts[i]);
    const key = Math.floor((px - minX) / cellSize) + ',' + Math.floor((py - minY) / cellSize);
    const bucket = cellMap.get(key);
    if (bucket) bucket.push(i); else cellMap.set(key, [i]);
  }
  return { spacing, cellSize, minX, minY, cellMap, count: pts.length };
}

/**
 * 建索引（**按传入的桶边长**，而不是固定的 `spacing × 2`）。
 *
 * 为什么需要第二种桶边长：查询半径的语义各工具不同（笔刷是 `spacing × 2`，河流找邻居是
 * `spacing × 1.5`）。桶越大 → 每次查询要扫的候选越多；桶越小 → 查询时要扫的桶越多。
 * 桶边长约等于查询半径时最省。⚠️ 它与 `buildGridIndex` 的区别**只有桶边长**，
 * 键的算法逐字相同（同一张网格建两种索引必须落在同一套格子里，否则"吸管吸到的格"
 * 与"笔刷刷到的格"慢慢就不是同一格 —— 且不报错）。
 *
 * @param {{points:Array, spacing?:number}} grid
 * @param {number} cellSize 桶边长（世界单位）
 */
export function buildGridIndexWithCellSize(grid, cellSize) {
  const pts = grid && grid.points;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const spacing = (grid.spacing || DEFAULT_SPACING);
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : spacing * 2;

  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pointXY(pts[i]);
    if (px < minX) minX = px;
    if (py < minY) minY = py;
  }

  const cellMap = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pointXY(pts[i]);
    const key = Math.floor((px - minX) / size) + ',' + Math.floor((py - minY) / size);
    const bucket = cellMap.get(key);
    if (bucket) bucket.push(i); else cellMap.set(key, [i]);
  }
  return { spacing, cellSize: size, minX, minY, cellMap, count: pts.length };
}

/** 落点半径内的**候选**下标（未做距离过滤 —— 见文件头说明） */
export function collectInRadius(index, worldX, worldY, radius) {
  if (!index) return [];
  const { cellSize, minX, minY, cellMap } = index;
  const c0 = Math.floor((worldX - radius - minX) / cellSize);
  const c1 = Math.floor((worldX + radius - minX) / cellSize);
  const r0 = Math.floor((worldY - radius - minY) / cellSize);
  const r1 = Math.floor((worldY + radius - minY) / cellSize);
  const out = [];
  for (let ci = c0; ci <= c1; ci++) {
    for (let cj = r0; cj <= r1; cj++) {
      const bucket = cellMap.get(ci + ',' + cj);
      if (bucket) {
        for (let k = 0; k < bucket.length; k++) out.push(bucket[k]);
      }
    }
  }
  return out;
}
