// utils/fmg/lattice.js — 网格点阵（B 阶段 2：square 采样 + 抖动；B⑤ 起默认 Voronoi 邻接）
//
// 逐行移植 SP-1025 `core/graph/lattice.ts` 的 square 分支（Azgaar MIT，见 THIRD_PARTY_NOTICES）：
//   · 每格点落在 `dx/2 + col*dx`、`dy/2 + row*dy` 的槽位上，再**随机抖动**（±jitter×半个邻居距）；
//   · 抖动范围夹在图幅内；
//   · 每个点**固定掷两次随机**（哪怕 jitter=0）—— 这样"关掉抖动"不会让后续随机流的相位漂移，
//     否则同一 seed 下改一个参数会让整张图完全不同（上游注释专门写了这条）。
//
// 邻接：默认 `buildVoronoiAdjacency`（Delaunay 边集 = Voronoi 邻接，B⑤）；`buildAdjacency` 是 8 邻居退路。
import Delaunator from 'delaunator';

/** 图幅 + 格距 → 行列数（与上游同一公式，`1e-10` 防浮点把整行挤掉） */
export function latticeSize(width, height, spacing) {
  const cellsX = Math.floor((width + 0.5 * spacing - 1e-10) / spacing);
  const cellsY = Math.floor((height + 0.5 * spacing - 1e-10) / spacing);
  return { cellsX: Math.max(1, cellsX), cellsY: Math.max(1, cellsY) };
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 放置格点。
 * @param {{width:number, height:number, spacing:number, jitter?:number}} o
 * @param {{next:() => number}} rng 显式随机流（`createFmgRandom` 的产物）
 * @returns {{cellsX:number, cellsY:number, spacing:number, points:Array<[number,number]>}}
 */
export function placePoints(o, rng) {
  const width = Number(o.width) || 1600;
  const height = Number(o.height) || 1000;
  const spacing = Number(o.spacing) > 0 ? Number(o.spacing) : 20;
  const jitter = Number.isFinite(o.jitter) ? Math.max(0, Math.min(0.9, o.jitter)) : 0.9;
  const { cellsX, cellsY } = latticeSize(width, height, spacing);
  const half = (spacing / 2) * jitter;
  const span = half * 2;

  const points = new Array(cellsX * cellsY);
  for (let row = 0, y = spacing / 2; row < cellsY; row++, y += spacing) {
    for (let col = 0, x = spacing / 2; col < cellsX; col++, x += spacing) {
      // ⚠️ 两次掷骰必须无条件执行（与上游一致）：jitter=0 时也不能省，否则随机流相位变了
      const jx = rng.next() * span - half;
      const jy = rng.next() * span - half;
      points[row * cellsX + col] = [
        round2(Math.max(0, Math.min(width, x + jx))),
        round2(Math.max(0, Math.min(height, y + jy))),
      ];
    }
  }
  return { cellsX, cellsY, spacing, points };
}

/**
 * 世界坐标 → 槽位下标（上游 `findSlot`；规则网格下 = 就是"落在哪一格"）。
 * 越界**夹到边界**（上游同样夹，不返回 -1）：模板工具的落点永远落在图内。
 */
export function findSlot(x, y, lattice) {
  const { spacing, cellsX, cellsY } = lattice;
  const row = Math.max(0, Math.floor(Math.min(y / spacing, cellsY - 1)));
  const col = Math.max(0, Math.floor(Math.min(x / spacing, cellsX - 1)));
  return row * cellsX + col;
}

/**
 * 规则方阵的 **8 邻居**邻接表（含对角）。
 *
 * 这是**退路**（`adjacency: 'grid'`）：第一步用它跑通，B⑤ 起默认走 Voronoi 邻接。
 * 与 Voronoi 的差别：邻居数恒为 3~8（角上 3、边上 5、内部 8），方向固定 → Hill/Trough 的扩散
 * 会沿格轴留下"十字/对角"的痕迹；Voronoi 的邻居方向随点抖动而变，地貌更自然。
 */
/**
 * **Voronoi 邻接（B⑤，2026-10-29）**：抖动点阵上做 Delaunay 三角化，边集就是 Voronoi 的邻接。
 *
 * 为什么是这一份而不是自己写：Delaunay 边集 = Voronoi 图的对偶，数学上就是"共享一条边"的 cell 对；
 * `delaunator`（ISC，Mapbox 出的，几十 KB）是这套算法的事实标准。自己写 Bowyer-Watson 只会多一个
 * 藏在退化情形里的坑（近共线/重复点）。
 *
 * 传进来的点必须**互不重合**：`placePoints` 的抖动上限是 0.45×格距，两边各抖也留 0.1×格距，
 * 所以正常不会撞点；真撞了 `delaunator` 会忽略重复点（那格就没有邻居）—— 这里补一个"孤点兜底"：
 * 邻居为空的点接上 8 邻居里的最近者，免得模板工具在它身上空转。
 *
 * @param {Array<[number, number]>} points
 * @param {number} cellsX
 * @param {number} cellsY
 * @returns {number[][]} 每个点的邻居（升序，去重）
 */
export function buildVoronoiAdjacency(points, cellsX, cellsY) {
  const n = Array.isArray(points) ? points.length : 0;
  if (!n) return [];
  const c = new Array(n);
  for (let i = 0; i < n; i++) c[i] = [];
  if (n < 4) return buildAdjacency(cellsX, cellsY);
  const coords = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    coords[i * 2] = points[i][0];
    coords[i * 2 + 1] = points[i][1];
  }
  let tri = null;
  try {
    tri = new Delaunator(coords).triangles;
  } catch (e) {
    // 三角化失败（退化输入）→ 退回 8 邻居：宁可粗一点，也不让生成整块失败
    return buildAdjacency(cellsX, cellsY);
  }
  const seen = new Array(n);
  for (let i = 0; i < n; i++) seen[i] = new Set();
  const link = (a, b) => {
    if (a === b) return;
    if (!seen[a].has(b)) { seen[a].add(b); c[a].push(b); }
    if (!seen[b].has(a)) { seen[b].add(a); c[b].push(a); }
  };
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const a = tri[i], b = tri[i + 1], d = tri[i + 2];
    link(a, b); link(b, d); link(d, a);
  }
  // 孤点兜底 + 升序（顺序确定 → 同 seed 结果可复现）
  for (let i = 0; i < n; i++) {
    if (c[i].length === 0) {
      // 取上/下/左/右里存在的那些（确定性兜底；只为不让模板工具在孤点上空转）
      const row = Math.floor(i / cellsX);
      const col = i % cellsX;
      if (col > 0) link(i, i - 1);
      if (col < cellsX - 1) link(i, i + 1);
      if (row > 0) link(i, i - cellsX);
      if (row < cellsY - 1) link(i, i + cellsX);
    }
    c[i].sort((a, b) => a - b);
  }
  return c;
}
/**
 * 规则方阵的 **8 邻居**邻接表（含对角）。
 *
 * 这是**退路**（`adjacency: 'grid'`）：第一步用它跑通，B⑤ 起默认走 Voronoi 邻接。
 * 与 Voronoi 的差别：邻居数恒为 3~8（角上 3、边上 5、内部 8），方向固定 → Hill/Trough 的扩散
 * 会沿格轴留下"十字/对角"的痕迹；Voronoi 的邻居方向随点抖动而变，地貌更自然。
 */
export function buildAdjacency(cellsX, cellsY) {
  const n = cellsX * cellsY;
  const c = new Array(n);
  for (let row = 0; row < cellsY; row++) {
    for (let col = 0; col < cellsX; col++) {
      const i = row * cellsX + col;
      const list = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const r2 = row + dy;
          const c2 = col + dx;
          if (r2 < 0 || r2 >= cellsY || c2 < 0 || c2 >= cellsX) continue;
          list.push(r2 * cellsX + c2);
        }
      }
      c[i] = list;
    }
  }
  return c;
}
