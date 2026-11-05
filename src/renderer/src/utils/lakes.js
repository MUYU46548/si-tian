// utils/lakes.js — **湖的唯一实现**（2026-11-04：从 `utils/fmg/index.js` 搬出）
//
// 为什么搬：湖现在有两处要**产出**（FMG 模板地形 `fmg/index.js` 与按轮廓推演
// `terrainSynthesis.js`），而后者不能 import 前者（`fmg/index` 已经 import 了
// `terrainSynthesis.fillDepressions` → 会成环）。判据逻辑一份、两条生成路径共用。
//
// 🔴 关键口径（2026-10-29 定，别改）：**不动高度场**。湖是 `hm.lakes` 这份
// **渲染层水面标记**（`{level, cells}`），高度仍然是"填平之后、处处可排水"的那份。
// 把湖格挖成 18/19 会在高度场上造出**没有出水口**的盆地 → 河流在湖边断头
// （本项目明令禁止的形态）。保留可排水高度 + 单独标记水面，等于"湖是水面，不是地形洞"
// —— 河照样从湖里穿过去、从出口出来（`utils/fmg/rivers.js` 按 `lakeOf` 处理）。

/**
 * 被洼地填平**抬起来**的连通块 → 湖。
 *
 * 判定：抬升量 ≥ `minDepth` 的陆格按 8 邻居聚成连通块，面积 ≥ `minArea` 的才算湖；
 * 水位取块内**最高的填充高度**（≈ 溢出口高度）。
 *
 * 🔴 为什么要 `minDepth`：priority-flood 会沿"排水通道"把整条平坦路径一格一档地抬（ε≈0.04），
 * 实测 974 个抬高格里 **p50 = 0.00 / p90 = 0.04** —— 绝大多数是通道噪声，不是盆地。
 * 不设深度门槛会把整条流路当成一个"488 格的湖"（实测），水位还被算到 97（接近峰顶）。
 *
 * @param {Float32Array|Float64Array} filled 填洼后的高度
 * @param {Array<{i:number,before:number,after:number}>} basins `fillDepressions` 记下的抬高格
 * @param {number} cellsX @param {number} cellsY
 * @param {{minArea?:number, minDepth?:number, maxLakes?:number, maxCells?:number}} [opts]
 * @returns {Array<{level:number, cells:number[]}>} 按面积从大到小
 */
export function detectBasinLakes(filled, basins, cellsX, cellsY, opts = {}) {
  const n = filled ? filled.length : 0;
  if (!n || cellsX < 2 || cellsY < 2) return [];
  const minArea = Math.max(4, Math.floor(Number(opts.minArea) || 8));
  const minDepth = Number.isFinite(opts.minDepth) ? Math.max(0, Number(opts.minDepth)) : 0.5;
  const maxLakes = Math.max(1, Math.floor(Number(opts.maxLakes) || 40));
  const maxCells = Math.max(100, Math.floor(Number(opts.maxCells) || 6000));

  const raised = new Uint8Array(n);
  for (const b of (basins || [])) {
    if (!b || !Number.isInteger(b.i) || b.i < 0 || b.i >= n) continue;
    if (Number(b.after) - Number(b.before) >= minDepth) raised[b.i] = 1;
  }
  const seen = new Uint8Array(n);
  const out = [];
  for (let start = 0; start < n; start++) {
    if (!raised[start] || seen[start]) continue;
    const comp = [];
    const queue = [start];
    seen[start] = 1;
    let level = -Infinity;
    while (queue.length) {
      const cur = queue.pop();
      comp.push(cur);
      if (filled[cur] > level) level = filled[cur];
      const ci = cur % cellsX;
      const cj = (cur - ci) / cellsX;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cellsX || nj >= cellsY) continue;
          const idx = nj * cellsX + ni;
          if (!raised[idx] || seen[idx]) continue;
          seen[idx] = 1;
          queue.push(idx);
        }
      }
    }
    if (comp.length >= minArea) {
      comp.sort((a, b) => a - b);
      out.push({ level: Math.round(level * 100) / 100, cells: comp });
    }
  }
  out.sort((a, b) => (b.cells.length - a.cells.length) || (a.cells[0] - b.cells[0]));
  // 体积上限：湖是**元数据**，最大的一条也可能是几百格；只留最大的若干条 + 总格数封顶
  const kept = [];
  let budget = maxCells;
  for (const lake of out) {
    if (kept.length >= maxLakes || lake.cells.length > budget) continue;
    budget -= lake.cells.length;
    kept.push(lake);
  }
  return kept;
}
