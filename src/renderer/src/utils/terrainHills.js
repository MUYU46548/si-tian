// utils/terrainHills.js — **多尺度丘陵**：把“穹顶 + 平行脊线”的坡面打散成大小不一的丘与盆
//
// ── 为什么它是独立的（2026-11-04 从 `landmass.js` 抽出来）──────────────────────
//   P2 实验（`build/terrain-erosion/`）量出来的事实：只加“排水盆地骨架 + 坡面侵蚀”时，
//   最长源—海路径 394 → 546（通了）、入海口 500 → 425（在收敛），但**扇状度 0.852 → 0.902**
//   （反而更平行）。原因写在 `drainageBasins.js` 里了：盆地骨架让水朝一个出口汇，
//   但盆地内部的坡面仍然是光滑的径向扇 → 8 格窗口内河道当然还是平行的。
//   8 格尺度上的方向变化只能来自**局部起伏**：一堆半径 2~9 格、高低不一的丘与盆。
//   这段代码原先只在造陆路径里（`landmass.js` 第四轮），现在抽成模块，
//   让“从轮廓推演地形”和“造陆”两条路读到**同一份**丘陵实现（红线：同一能力只许一份）。
//
// ── 做法 ───────────────────────────────────────────────────────────────────
//   按 `1/r` 幂律撒丘（小丘多、大丘少），30%（可调）是**负丘（盆）**——盆是“水留一会儿再走”
//   的地方，也是分叉点。18% 的丘被拉长成**脊**：脊两侧的坡会把水逼到同一条谷里。
//   只动陆地格：丘盘越界会把海格抬过海平面 → 栅格陆地比海岸环多一圈。
//
// ⚠️ 纯函数（就地改 `hm.h`），随机只来自传入的 `rng`；同一 seed + 同一 rng 序列 → 同一份结果。

/**
 * @param {{h:number[], grid:{cellsX:number,cellsY:number,spacing:number}}} hm 就地修改
 * @param {{count:number, rMin:number, rMax:number, ampMin:number, ampMax:number,
 *          seaLevel?:number, basinRate?:number, rng:()=>number}} opts
 *   `rMin/rMax` 是**格**；`amp` 是高度点
 * @returns {{placed:number, skipped:number}}
 */
export function scatterHills(hm, opts) {
  const { cellsX: cols, cellsY: rows } = hm.grid;
  const sea = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const rng = opts.rng;
  const count = Math.max(0, Math.round(opts.count));
  let placed = 0, skipped = 0, guard = 0;
  while (placed < count && guard++ < count * 30) {
    const ci = 2 + Math.floor(rng() * Math.max(1, cols - 4));
    const cj = 2 + Math.floor(rng() * Math.max(1, rows - 4));
    const ck = cj * cols + ci;
    if (hm.h[ck] < sea + 0.6) { skipped++; continue; }        // 只落在陆地上
    // 半径按 1/r 幂律：小丘多、大丘少（真实地形的“丘陵谱”就长这样）
    const r = opts.rMin + (opts.rMax - opts.rMin) * Math.pow(rng(), 1.7);
    const amp = (opts.ampMin + (opts.ampMax - opts.ampMin) * Math.pow(rng(), 1.4))
      * (rng() < (opts.basinRate == null ? 0.3 : opts.basinRate) ? -1 : 1);
    // 18% 是**脊**（拉长的丘）：真实大陆上“圆圆的小丘”只占一半，另一半是成串的山脊。
    // 脊还有个副作用是我们要的：山脊两侧的坡会把水**逼到同一条谷**里。
    const isRidge = rng() < 0.18;
    const elong = isRidge ? 1.8 + rng() * 1.8 : 1;
    const ang = isRidge ? rng() * Math.PI : 0;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const reach = r * elong;
    const i0 = Math.max(1, Math.floor(ci - reach)), i1 = Math.min(cols - 2, Math.ceil(ci + reach));
    const j0 = Math.max(1, Math.floor(cj - reach)), j1 = Math.min(rows - 2, Math.ceil(cj + reach));
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        let dx = ii - ci, dy = jj - cj;
        if (isRidge) {                                    // 转到脊的坐标系里量距离
          const rx = dx * ca + dy * sa;
          const ry = -dx * sa + dy * ca;
          dx = rx / elong;
          dy = ry;
        }
        const d = Math.hypot(dx, dy) / r;
        if (d >= 1) continue;
        const f = (1 - d * d) ** 2;
        const k = jj * cols + ii;
        // 🔴 **只动陆地格**：丘的圆盘会越过海岸线。若把海格也抬过 20，栅格里的陆地就比
        //    海岸环多出一圈（实测面积 +21%，a10 当场抓住），而省份是按环切的 ——
        //    画面上就是“水里明明该有省，却没有”。
        if (hm.h[k] < sea + 0.6) continue;
        // 负丘（盆）不许把陆地压到海平面以下：那会在轮廓里凭空多出一个“湖”，
        // 而海岸环并不知道它（预览里是蓝斑、省份却盖在上面）。压到 sea+0.4 就够成洼了。
        hm.h[k] = Math.max(sea + 0.4, hm.h[k] + amp * f);
      }
    }
    placed++;
  }
  for (let k = 0; k < hm.h.length; k++) hm.h[k] = Math.round(hm.h[k] * 100) / 100;
  return { placed, skipped };
}
