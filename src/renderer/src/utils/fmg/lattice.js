// utils/fmg/lattice.js — 网格点阵（B 阶段 2 第一步：**只做 square 采样 + 抖动**）
//
// 逐行移植 SP-1025 `core/graph/lattice.ts` 的 square 分支（Azgaar MIT，见 THIRD_PARTY_NOTICES）：
//   · 每格点落在 `dx/2 + col*dx`、`dy/2 + row*dy` 的槽位上，再**随机抖动**（±jitter×半个邻居距）；
//   · 抖动范围夹在图幅内；
//   · 每个点**固定掷两次随机**（哪怕 jitter=0）—— 这样"关掉抖动"不会让后续随机流的相位漂移，
//     否则同一 seed 下改一个参数会让整张图完全不同（上游注释专门写了这条）。
//
// 为什么第一步只要 square：hex/diamond/triangle 只影响点的排布与邻接距离，而高度模板工具只用到
// "点在哪 / 谁是邻居"。先把 square + 抖动跑通，判据（同 seed 一致 / 8k < 1s）立起来；换采样是纯替换。

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
 * 与上游的差别要写清：上游是 Voronoi 邻接（抖动点阵 + Delaunay），邻居数 3~8、距离不等；
 * 这里第一步用 8 邻居 —— 抖动点阵上它仍然"最像 Voronoi"，但**不是同构**，所以两边的高度图不会逐字节相同
 * （我们只保证**自己**同 seed 逐字节一致）。等接 Voronoi 时把这一份换掉即可（调用方只依赖 `cells.c`）。
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
