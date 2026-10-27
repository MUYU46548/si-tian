// utils/seaDepth.js — 海深场（**渲染期推导**，不落盘；2026-10-26）
//
// ── 为什么要有它（用户第 N 次：「海面层次：参考图有浅海/深海/等深线的过渡，我们是一片纯蓝」）──
// 实测真实底图（`绒花计划.sitian` 的 desite）：**2539 个海格的高度全是 12.0，一个例外都没有**。
// 造陆侧更直接：`synthesizeHeightmapFromTerrain` 把海格写成 `seaLevel - 8`（= 12）——
// 海深在数据里根本不存在。于是 `HYPSO_WATER` 那 5 个色只用得上 1 个，
// 整片海是同一个色号，等深线也无从下笔。
//
// 三个选项：
//   · 把海深写进高度图 —— 415 省老项目要迁移，项目文件要变大，且"海深"不是世界观数据；
//   · 每帧现算 —— 4365 格的 BFS 不贵，但等深线几何每帧重跑就是白烧；
//   · **推导一次 + 按高度图引用缓存**（本模块的选法）：零迁移、老项目/新造陆/导入图一视同仁，
//     画布、等深线、导出读同一份结论（与「同一能力只许一份实现」同一条纪律）。
//
// ── 口径 ────────────────────────────────────────────────────────────────────
// 海深 = 该海格**离岸多远**（8 邻域 Chamfer 距离，源 = 陆格），按**本幅图自己的距岸分布**
// 归一化：`ref = 海格距岸的 p70`，`t = 1 - exp(-d / ref)`。t=0 = 贴着岸，t=1 = 本幅图最深处。
//
// 🔴 为什么必须按分布归一化（本项目第四修起的铁律）：绝对的"8 格算最深"在 97×45 的导入图上
//    是合理值，在 170×80 的造陆图上会把 80% 的海面压成最深的同一个色 —— 换一份数据就失效，
//    而失效的表现是"看起来没生效"。
//
// 🔴 为什么用指数映射而不是线性：线性 `d/ref` 下贴岸一格只有 1/ref ≈ 0.25、深海一路顶到 1，
//    近岸那一档几乎看不出；指数映射"近岸最敏感、远处渐近"，浅海带才立得住（参考图正是这样）。
//
// 🔴 兼容"真海深"：若某天海格高度本身有起伏（`max - min > 1.5`），优先用
//    `t = (seaLevel - h) / HEIGHT_DEPTH_UNITS`（越低越深），距岸只做兜底 ——
//    那时数据里已经有真水深了，再用距岸去猜就是拿错的证据下结论。
//
// 纯函数：不碰 DOM / store，Node 可直接测（`scripts/tests/unit/test_sea_depth.js`）。

/** 海面分带数（与 `heightmapRaster.HYPSO_WATER` 的色数一致：5 档，浅 → 深） */
export const SEA_DEPTH_BANDS = 5;

/** 等深线的 t 档位（0 = 岸线，1 = 最深）。参考图是 2~3 条，这里给 3 条。 */
export const SEA_DEPTH_LEVELS = Object.freeze([0.22, 0.48, 0.74]);

/** 海格高度的起伏超过这个量 → 认定数据里有**真海深**，不再用距岸兜底 */
export const SEA_HEIGHT_MIN_SPAN = 1.5;

/** 真海深口径下的"海深量程"（高度点）：12 → 20 这段在真实底图上正好是大陆架的量级 */
export const SEA_HEIGHT_DEPTH_UNITS = 8;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 8 邻域 Chamfer 距离场（纯几何，两个调用方共用：海深 / 距海）。
 *
 * @param {number} n @param {number} cols @param {number} rows
 * @param {(i:number)=>boolean} isSource 源格 → 距离 0
 * @returns {Float32Array} 每格到最近源的距离（格为单位，≈欧氏）
 */
export function chamferDistance(n, cols, rows, isSource) {
  const dist = new Float32Array(n);
  const FAR = 1e9;
  for (let i = 0; i < n; i++) dist[i] = isSource(i) ? 0 : FAR;
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      let v = dist[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, dist[i - 1] + D1);
      if (y > 0) v = Math.min(v, dist[i - cols] + D1);
      if (x > 0 && y > 0) v = Math.min(v, dist[i - cols - 1] + D2);
      if (x < cols - 1 && y > 0) v = Math.min(v, dist[i - cols + 1] + D2);
      dist[i] = v;
    }
  }
  for (let y = rows - 1; y >= 0; y--) {
    for (let x = cols - 1; x >= 0; x--) {
      const i = y * cols + x;
      let v = dist[i];
      if (v === 0) continue;
      if (x < cols - 1) v = Math.min(v, dist[i + 1] + D1);
      if (y < rows - 1) v = Math.min(v, dist[i + cols] + D1);
      if (x < cols - 1 && y < rows - 1) v = Math.min(v, dist[i + cols + 1] + D2);
      if (x > 0 && y < rows - 1) v = Math.min(v, dist[i + cols - 1] + D2);
      dist[i] = v;
    }
  }
  return dist;
}

/**
 * 陆格到海的**距离场**（2026-10-26，逐点河宽配套）。
 *
 * 用途：判断一条河的**哪一端是河口**（离海更近的那端）。
 * 🔴 为什么不用"两端地形高度"：实测 159 条导入河里 **156 条两端落在同一格高度**
 *    （97×45 的格距 18 世界单位，河端差不到一格）—— 高度差判不出方向，必须用距离。
 *
 * @param {object} hm
 * @param {{seaLevel?:number}} [opts]
 * @returns {{dist:Float32Array, cols:number, rows:number}|null} 海格 = 0
 */
export function buildDistanceToSea(hm, opts = {}) {
  const grid = hm && hm.grid;
  const h = hm && hm.h;
  if (!grid || !h || !h.length) return null;
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  if (!(cols > 1) || !(rows > 1) || cols * rows > h.length) return null;
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  let sea = 0;
  for (let i = 0; i < cols * rows; i++) if ((h[i] || 0) < seaLevel) sea++;
  if (!sea) return null;
  const dist = chamferDistance(cols * rows, cols, rows, (i) => (h[i] || 0) < seaLevel);
  return { dist, cols, rows };
}

/**
 * 在格心网格上**最近格**采样（不插值）—— 只用于"哪端离海更近"这类定性判断。
 * 出界 / 无数据 → NaN（调用方必须判，别把 NaN 当 0）。
 */
export function sampleGridAt(hm, field, x, y) {
  const g = hm && hm.grid;
  if (!g || !field || !Array.isArray(g.points) && !(g.points && g.points.length)) return NaN;
  const cols = g.cellsX | 0;
  const rows = g.cellsY | 0;
  const spacing = Number(g.spacing) || 0;
  const p0 = g.points && g.points[0];
  if (!(cols > 0) || !(rows > 0) || !(spacing > 0) || !p0) return NaN;
  const ox = Array.isArray(p0) ? p0[0] : p0.x;
  const oy = Array.isArray(p0) ? p0[1] : p0.y;
  const c = Math.round((x - ox) / spacing);
  const r = Math.round((y - oy) / spacing);
  if (c < 0 || c >= cols || r < 0 || r >= rows) return NaN;
  return field[r * cols + c];
}

/** 升序数组的分位数（q ∈ 0..1）。空数组 → NaN（调用方必须判） */
function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = Math.max(0, Math.min(1, q)) * (n - 1);
  const i = Math.floor(pos);
  const j = Math.min(n - 1, i + 1);
  return sorted[i] + (sorted[j] - sorted[i]) * (pos - i);
}

/**
 * 由高度图推导海深场。
 *
 * @param {object} hm 高度图（`{h, grid:{cellsX,cellsY,points,spacing}}`）
 * @param {{seaLevel?:number, smooth?:boolean, refQuantile?:number}} [opts]
 * @returns {{t:Float32Array, ref:number, mode:'distance'|'height', seaCells:number,
 *            maxDepthCells:number, cols:number, rows:number}|null}
 *   海格不足 1 格 → `null`（没有海面可画，调用方按旧口径兜底）。
 */
export function buildSeaDepth(hm, opts = {}) {
  const grid = hm && hm.grid;
  const h = hm && hm.h;
  if (!grid || !h || !h.length) return null;
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  if (!(cols > 0) || !(rows > 0) || cols * rows > h.length) return null;
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;

  const n = cols * rows;
  const t = new Float32Array(n);
  let seaCells = 0;
  let landCells = 0;
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if ((h[i] || 0) < seaLevel) {
      seaCells++;
      if (h[i] < hMin) hMin = h[i];
      if (h[i] > hMax) hMax = h[i];
    } else {
      landCells++;
    }
  }
  if (!seaCells || !landCells) return null;   // 全陆或全海：没有"岸"可量

  // ── ① 真海深优先 ──────────────────────────────────────────────────────────
  // `opts.forceDistance`（2026-10-27）：老导入图的**海格 h 恒定 12**，按 h 算深度会整片
  // 一个色（没有浅滩带）；政治底图要的是"近岸青绿 → 远海深蓝"，所以强制走距离场。
  if (!opts.forceDistance && Number.isFinite(hMin) && hMax - hMin > SEA_HEIGHT_MIN_SPAN) {
    for (let i = 0; i < n; i++) {
      if ((h[i] || 0) >= seaLevel) continue;
      t[i] = clamp01((seaLevel - h[i]) / SEA_HEIGHT_DEPTH_UNITS);
    }
    if (opts.smooth !== false) smoothSeaField(t, cols, rows, h, seaLevel);
    return { t, ref: SEA_HEIGHT_DEPTH_UNITS, mode: 'height', seaCells, maxDepthCells: 0, cols, rows };
  }

  // ── ② 距岸距离（多源：所有陆格）──────────────────────────────────────────
  // 🔴 为什么不用 4 邻域 BFS：它算的是"走几步"，等距线是**方角**的（切比雪夫方框），
  //    等深线会画成一圈圈圆角矩形（实测截图）。8 邻域带 √2 权重 ≈ 欧氏距离，等距线才是圆的。
  // 实现与"距海距离"共用 `chamferDistance`（两个方向、一份几何）。
  const dist = chamferDistance(n, cols, rows, (i) => (h[i] || 0) >= seaLevel);
  const FAR = 1e9;

  // 平滑**距离场**（不是 t）：陆格是 0，参与平均 → 贴岸仍然浅（0.7 左右），
  // 而等距线从"八角形"被磨成圆角 —— 等深线的锯齿主要来自这里。
  // 两遍 3×3 足够；再平滑就把窄海峡填平了。
  smoothDistanceField(dist, cols, rows, 2);

  // ── ③ 按"本幅图的海格距岸分布"归一化 → 指数映射成 t ────────────────────────
  // 线性 `d/ref` 在贴岸一格处是 1/ref（很小）、深海里一路顶到 1 —— 近岸那一档几乎看不见。
  // `t = 1 - exp(-d/ref)` 让**近岸最敏感**（d=1 就有 0.22），同时远处渐近到 1 不溢出。
  const dists = [];
  let maxDepthCells = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i] > 0 && dist[i] < FAR) {
      dists.push(dist[i]);
      if (dist[i] > maxDepthCells) maxDepthCells = dist[i];
    }
  }
  dists.sort((a, b) => a - b);
  const q = Number.isFinite(opts.refQuantile) ? opts.refQuantile : 0.7;
  const ref = Math.max(2, quantileSorted(dists, q) || 2);
  for (let i = 0; i < n; i++) {
    if (dist[i] > 0 && dist[i] < FAR) t[i] = 1 - Math.exp(-dist[i] / ref);
  }

  // 默认**不平滑**：指数映射已经把"整数格台阶"消掉了，再平均只会把贴岸的浅水拉深
  // （实测两遍平均后海岸 t 从 0.22 抬到 0.44 —— 浅海带直接没了）。要平滑请显式传 `smooth:true`。
  if (opts.smooth === true) {
    const passes = Number.isFinite(opts.smoothPasses) ? Math.max(1, Math.min(3, opts.smoothPasses)) : 1;
    for (let p = 0; p < passes; p++) smoothSeaField(t, cols, rows, h, seaLevel);
  }
  return { t, ref, mode: 'distance', seaCells, maxDepthCells, cols, rows };
}

/**
 * 平滑**距离场**（陆格恒 0，只改写海格）—— 等深线锯齿的根治。
 *
 * 为什么不能平滑 t：t 是 exp 之后的量，平均会把贴岸的浅水直接拉到中深海（实测 0.22 → 0.44），
 * 浅海带就没了。平滑距离场则相反：陆格是 0，参与平均只会让岸更浅，等距线同时被磨圆。
 *
 * @param {Float32Array} dist 距岸距离（陆格 0；原地改写）
 * @param {number} cols @param {number} rows @param {number} [passes]
 * @returns {Float32Array} 同一个数组
 */
export function smoothDistanceField(dist, cols, rows, passes = 2) {
  const n = cols * rows;
  if (!dist || dist.length < n) return dist;
  const p = Math.max(1, Math.min(4, passes | 0));
  for (let it = 0; it < p; it++) {
    const prev = dist.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (!(prev[i] > 0)) continue;             // 陆格不动（保持 0）
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= cols) continue;
            sum += prev[ny * cols + nx];
            cnt++;
          }
        }
        if (cnt) dist[i] = sum / cnt;
      }
    }
  }
  return dist;
}

/**
 * 3×3 均值（只平滑海格，跨越陆格时**跳过**而不是把 0 混进来）。
 *
 * 为什么需要：距岸是整数格数，等深线在格边界上是台阶；一格宽的台阶在 1× 下就是一条锯齿。
 * 平滑只动形态、不动量级（t 仍在 0..1，岸格仍≈0）。
 */
export function smoothSeaField(t, cols, rows, h, seaLevel) {  const src = t.slice();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!(src[i] > 0)) continue;          // 陆格 / 贴岸格保持原值
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const k = ny * cols + nx;
          if ((h[k] || 0) >= seaLevel) continue;   // 陆格不参与（否则海岸会被拉浅）
          sum += src[k];
          cnt++;
        }
      }
      if (cnt) t[i] = clamp01(sum / cnt);
    }
  }
  return t;
}

/** t → 分带下标（0..bands-1）—— 与 `heightmapRaster` 的采样同一口径，导出供用例对拍 */
export function seaBandIndex(tValue, bands = SEA_DEPTH_BANDS) {
  const b = Math.max(1, bands | 0);
  const v = clamp01(Number.isFinite(tValue) ? tValue : 0);
  return Math.min(b - 1, Math.floor(v * b));
}

/**
 * 由**高精度陆地环**推导海深场（2026-10-27；粗格导入图专用）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 老 97×45 的 `.map` 导入图格距 **18.3 世界单位**：`extractIsoLines` 在这种格上
 * 一圈只出十来个像素一段的多边形，等于画不出等深线（`getSeaDetail` 的 spacing 闸门
 * 因此只给它渐变）。但这类图恰恰**带着高精度海岸线环**（`landFeatures`，实测 20 环 /
 * 1747 点）—— 有精度的海岸线，就能重建出一张足够细的"离岸距离"场。
 *
 * ── 做法（与 `buildSeaDepth` 同一套口径，只是数据源换成环）────────────────────
 *   ① 把环按**偶数奇偶**扫描线栅格化成细掩膜（`step` 世界单位一格，默认 4）；
 *   ② 对海格算 8 邻域 Chamfer 距岸距离（源 = 陆格），两遍平滑；
 *   ③ 按**本场自己的**距岸分布 p70 归一化，`t = 1 - exp(-d/ref)`（与高度图口径逐字一致）。
 *
 * @param {Array<Array<{x:number,y:number}|[number,number]>>} rings 陆地环（可多环、可带洞）
 * @param {{step?:number, maxCells?:number, refQuantile?:number}} [opts]
 * @returns {{t:Float32Array, cols:number, rows:number, points:Array<[number,number]>,
 *            step:number, ref:number, seaCells:number, mode:'rings'}|null}
 *   没有环 / 全陆 / 全海 → null（调用方退回"不画等深线"）。
 */
export function buildSeaDepthFromRings(rings, opts = {}) {
  const src = Array.isArray(rings) ? rings.filter((r) => Array.isArray(r) && r.length >= 3) : [];
  if (!src.length) return null;
  const xy = (p) => (Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : { x: Number(p && p.x), y: Number(p && p.y) });
  const clean = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of src) {
    const ring = [];
    for (const p of r) {
      const q = xy(p);
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
      ring.push(q);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    if (ring.length >= 3) clean.push(ring);
  }
  if (!clean.length || !Number.isFinite(minX)) return null;

  let step = Number(opts.step) > 0 ? Number(opts.step) : 4;
  const maxCells = Number(opts.maxCells) > 0 ? Number(opts.maxCells) : 250000;
  // 扩一圈边（海要延伸到环外，否则最外一排格没有"向外"的深度）
  const pad = step * 3;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  let cols = 0, rows = 0;
  // 格数超上限 → 加大格距（最多放 4 次；仍超就老实返回 null，不硬扛）
  for (let i = 0; i < 4; i++) {
    cols = Math.max(2, Math.ceil((maxX - minX) / step) + 1);
    rows = Math.max(2, Math.ceil((maxY - minY) / step) + 1);
    if (cols * rows <= maxCells) break;
    step *= 1.5;
  }
  if (cols * rows > maxCells) return null;

  const n = cols * rows;
  const land = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    const y = minY + r * step;
    const xs = [];
    for (const ring of clean) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const yi = ring[i].y, yj = ring[j].y;
        if ((yi > y) !== (yj > y)) {
          const t = (y - yj) / (yi - yj);
          xs.push(ring[j].x + (ring[i].x - ring[j].x) * t);
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    // 偶数奇偶填：第 1-2 个交点之间是陆地，第 3-4 个之间是陆地……（洞会被自然挖掉）
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - minX) / step - 0.5));
      const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - minX) / step - 0.5));
      for (let c = c0; c <= c1; c++) land[r * cols + c] = 1;
    }
  }
  let landCells = 0;
  for (let i = 0; i < n; i++) if (land[i]) landCells++;
  if (!landCells || landCells === n) return null;

  const dist = chamferDistance(n, cols, rows, (i) => land[i] === 1);
  smoothDistanceField(dist, cols, rows, 2);
  const FAR = 1e9;
  const dists = [];
  let seaCells = 0;
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    if (dist[i] > 0 && dist[i] < FAR) { dists.push(dist[i]); seaCells++; }
  }
  if (!seaCells) return null;
  dists.sort((a, b) => a - b);
  const q = Number.isFinite(opts.refQuantile) ? opts.refQuantile : 0.7;
  const ref = Math.max(2, quantileSorted(dists, q) || 2);
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    if (dist[i] > 0 && dist[i] < FAR) t[i] = 1 - Math.exp(-dist[i] / ref);
  }
  const points = new Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) points[r * cols + c] = [minX + c * step, minY + r * step];
  }
  return { t, cols, rows, points, step, ref, seaCells, mode: 'rings' };
}
