// utils/fmg/index.js — FMG 高度图管线入口（B 阶段 2 第一步，2026-10-29）
//
// 这一层的职责只有三件：**建点阵 → 跑模板 → 叠粗糙度**，最后交给司天的高度图形状。
// 判据（本步只要这两条）：
//   ① 同 seed 两次生成，`h` 逐字节一致（且不同 seed 明显不同）；
//   ② 8k 格 < 1s（真机 Node 实测，见 `unit/test_fmg_heightmap.js`）。
//
// ⚠️ **不要**在这里接 UI / store / undo：第一步只出"一张高度图"。落库、候选、撤销都沿用
//    A6 的 `synthesizeTerrainInto` 那一套（同一份写口），这里保持纯函数。
//
// 依赖：`rng.js`（显式随机流）/ `lattice.js`（点阵 + 8 邻居）/ `templates.js`（模板脚本）/
//       `generator.js`（脚本解释器）。粗糙度用司天自己的 `landmassField.fbm`（值噪声 fBm），
//       **不再引 `simplex-noise`**：这一步只需要"有细节"，不是要跟 FMG 逐字节同构。

import { createFmgRandom } from './rng';
import { placePoints, buildAdjacency } from './lattice';
import { buildContinentsTemplate, getTemplateScript, HEIGHT_TEMPLATES, TEMPLATE_IDS } from './templates';
import { HeightmapGenerator } from './generator';
import { fbm } from '../landmassField';
// B④（2026-10-29）：洼地填平复用 `terrainSynthesis.fillDepressions`（priority-flood，唯一实现）
import { fillDepressions } from '../terrainSynthesis';

export { HEIGHT_TEMPLATES, TEMPLATE_IDS };

export const FMG_SEA_LEVEL = 20;

/** 目标格数 → 格距（图幅面积 / 格数 开方；与上游同一思路） */
export function spacingForCells(width, height, cellsDesired) {
  const n = Math.max(64, Number(cellsDesired) || 8000);
  return Math.max(1, Math.sqrt((width * height) / n));
}

/**
 * 在模板高度图上叠 fBm 细节（移植上游 `applyRoughness` 的**形状**：陆上细、海里几乎不动）。
 * 上游用 simplex-noise；这里用仓内既有的值噪声 fBm（同一个理由是"不引第二个噪声库"）。
 */
export function applyRoughness(heights, lattice, roughness, seed) {
  const amount = Number(roughness);
  if (!(amount > 0)) return heights;
  const { points } = lattice;
  const amplitude = (Math.min(100, amount) / 100) * 18;
  const baseFrequency = 2 / Math.max(1, lattice.cellsX * lattice.spacing);
  const octaves = [1, 2, 4, 8];
  const weights = [0.55, 0.25, 0.13, 0.07];
  const out = new Uint8Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    const [x, y] = points[i];
    let value = 0;
    for (let o = 0; o < octaves.length; o++) {
      value += fbm(x * baseFrequency * octaves[o], y * baseFrequency * octaves[o], seed + o * 101, 2) * weights[o];
    }
    const detail = (value + 1) / 2;
    const bias = heights[i] >= 20 ? detail : detail * 0.3;
    const next = Math.round(heights[i] + (bias - 0.35) * amplitude * 2);
    out[i] = next < 0 ? 0 : next > 100 ? 100 : next;
  }
  return out;
}

/**
 * **洼地填平**（B④，2026-10-29）：FMG 模板地形有大量封闭盆地 → 司天的自动河流在它上面
 * **一条都长不出来**（实测 8k 格：continents / archipelago / oldWorld 全部 0 条）。
 * 用 `terrainSynthesis.fillDepressions`（priority-flood，仓库里唯一实现）抬平盆地，
 * 并把结果保留到 **2 位小数** —— ε 必须能在量化后活下来，否则又变成平层。
 *
 * @param {Uint8Array} heights
 * @param {number} cellsX
 * @param {number} cellsY
 * @returns {{heights:Float32Array, raisedCells:number}}
 */
export function fillBasins(heights, cellsX, cellsY) {
  const n = heights.length;
  const land = new Uint8Array(n);
  let maxH = 0;
  for (let i = 0; i < n; i++) {
    land[i] = heights[i] >= FMG_SEA_LEVEL ? 1 : 0;
    if (heights[i] > maxH) maxH = heights[i];
  }
  const eps = Math.max(0.01, (Math.max(1, maxH - FMG_SEA_LEVEL)) / 2000);
  const filled = fillDepressions(Float64Array.from(heights), land, cellsX, cellsY, FMG_SEA_LEVEL, eps);
  const out = new Float32Array(n);
  let raised = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round(filled[i] * 100) / 100;
    out[i] = v;
    if (land[i] && v > heights[i]) raised++;
  }
  return { heights: out, raisedCells: raised };
}

/**
 * 生成一张高度图。
 *
 * @param {object} o
 * @param {number|string} o.seed
 * @param {number} o.width 图幅宽（世界单位）
 * @param {number} o.height 图幅高（世界单位）
 * @param {number} [o.cellsDesired] 目标格数（默认 8000；由它推格距）
 * @param {string} [o.template] 模板脚本（给字符串就直接用，优先于 templateId）
 * @param {string} [o.templateId] `HEIGHT_TEMPLATES` 的键（默认 'continents'）
 * @param {{count:number,sizeVariance:number}} [o.continents] 给了就用 `buildContinentsTemplate` 展开
 * @param {number} [o.roughness] 0..100
 * @param {number} [o.jitter] 点抖动 0..0.9（默认 0.9，与上游同一档）
 * @param {number} [o.coverage] 陆地覆盖率目标（默认 0.35；0 = 不校准）
 * @param {boolean} [o.fillBasins] 是否填平洼地（默认 **true**；关掉 = 自动河流长不出来，仅用于对照实验）
 * @returns {{h:Float32Array, cellsX:number, cellsY:number, spacing:number, points:Array, template:string,
 *            seed:number|string, landRatio:number, seaShift:number, raisedCells:number, elapsedMs:number}}
 */
export function generateHeightmap(o = {}) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const width = Number(o.width) > 0 ? Number(o.width) : 1600;
  const height = Number(o.height) > 0 ? Number(o.height) : 1000;
  const spacing = spacingForCells(width, height, o.cellsDesired || 8000);
  const seed = o.seed == null ? 1 : o.seed;
  const rng = createFmgRandom(seed);

  const lattice = placePoints({ width, height, spacing, jitter: o.jitter }, rng);
  lattice.c = buildAdjacency(lattice.cellsX, lattice.cellsY);

  let script;
  if (typeof o.template === 'string' && o.template.trim()) script = o.template;
  else if (o.continents) script = buildContinentsTemplate(o.continents, width, height, rng);
  else script = getTemplateScript(o.templateId || 'continents');

  const gen = new HeightmapGenerator(lattice, rng, {
    width,
    height,
    cellsDesired: lattice.cellsX * lattice.cellsY,
  });
  let h = gen.run(new Uint8Array(lattice.cellsX * lattice.cellsY), script);
  h = applyRoughness(h, lattice, o.roughness || 0, typeof seed === 'number' ? seed : 1);
  // 覆盖率校准（默认 35% 陆地；`coverage: 0` 可关掉，保留模板原样）
  const coverage = o.coverage == null ? 0.35 : Number(o.coverage);
  const cal = coverage > 0
    ? calibrateCoverage(h, coverage)
    : { heights: h, shoreline: FMG_SEA_LEVEL, scale: 1, ratio: landRatioOf(h) };
  h = cal.heights;
  // 填平洼地（B④）：不填的话自动河流一条都长不出来（实测）；填完 h 变成 2 位小数的 Float32Array
  let raisedCells = 0;
  if (o.fillBasins !== false) {
    const fb = fillBasins(h, lattice.cellsX, lattice.cellsY);
    h = fb.heights;
    raisedCells = fb.raisedCells;
  }

  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return {
    h,
    cellsX: lattice.cellsX,
    cellsY: lattice.cellsY,
    spacing: lattice.spacing,
    points: lattice.points,
    template: script,
    seed,
    landRatio: landRatioOf(h),
    shoreline: cal.shoreline,
    landScale: cal.scale,
    raisedCells,
    elapsedMs: Math.round(t1 - t0),
  };
}

/**
 * 生成结果 → 司天的高度图形状（`{h, grid:{points, spacing, cellsX, cellsY}}`）。
 *
 * ⚠️ 只换形状、**不碰 store**：要不要落库由调用方（A6 的 `synthesizeTerrainInto`）决定。
 * 高度单位两边一致（0..100，海平面 20），不需要换算 —— 这是选 FMG 这套模板的前提。
 */
export function toSitianHeightmap(result, opts = {}) {
  if (!result || !result.h) return null;
  const ox = Number(opts.originX) || 0;
  const oy = Number(opts.originY) || 0;
  const points = new Array(result.points.length);
  for (let i = 0; i < result.points.length; i++) {
    const [x, y] = result.points[i];
    points[i] = [x + ox, y + oy];
  }
  return {
    h: Float32Array.from(result.h),
    grid: {
      points,
      spacing: result.spacing,
      cellsX: result.cellsX,
      cellsY: result.cellsY,
      count: result.h.length,
    },
  };
}

/** 陆地占比（高度 >= 20 的格数占比）；回执与判据都用它 */
export function landRatioOf(heights) {
  if (!heights || !heights.length) return 0;
  let land = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] >= 20) land++;
  return land / heights.length;
}

/**
 * **陆地覆盖率校准**（本层的补充，不是上游代码）。
 *
 * 为什么必须有：模板只保证"地貌像"，不管陆地占比 —— 实测 `continents` 模板在 4000 格上是
 * **87% 陆地**（几乎没有海）。而"陆地占比"是用户能感知的产品参数，也是本步判据（覆盖率 ±1%）。
 *
 * 做法（2026-10-29 第二版）：**找分位值当海岸线，再把陆上落差拉伸到 0..100**。
 *   · 取 `q` = 原高度图的 `(1-coverage)` 分位 → 令 `h' = 20 + (h - q)·k`，使 `q → 20`、`max → 100`。
 *   · 为什么不是第一版那种"整体平移"：平移会把**山峰一起压下去**（覆盖率高时实测峰值只剩 ~50），
 *     而自动河流的源头闸门是绝对高度 `> 60` → 河一条都长不出来。拉伸保留相对落差、峰值仍到 100。
 *   · 只用一个 `k`（全域同一个缩放）—— 不做非线性，免得把海岸坡度改得不像地形。
 *
 * @param {Uint8Array|Float32Array} heights
 * @param {number} target 0..1
 * @returns {{heights:Float32Array, shoreline:number, scale:number, ratio:number}}
 */
export function calibrateCoverage(heights, target) {
  const goal = Math.max(0, Math.min(1, Number(target)));
  const n = heights ? heights.length : 0;
  if (!(goal > 0) || !n) {
    return { heights, shoreline: FMG_SEA_LEVEL, scale: 1, ratio: landRatioOf(heights) };
  }
  const sorted = Array.from(heights).sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.max(0, Math.round((1 - goal) * n)));
  const shoreline = sorted[idx];
  const maxH = sorted[n - 1];
  // 拉伸系数：海岸线 → 20、峰值 → 100；夹在 [1, 6]（只拉伸不压缩：压缩会把峰压到 60 以下）
  const scale = Math.max(1, Math.min(6, (100 - FMG_SEA_LEVEL) / Math.max(1e-6, maxH - shoreline)));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = FMG_SEA_LEVEL + (heights[i] - shoreline) * scale;
    if (v < 0) v = 0;
    else if (v > 100) v = 100;
    out[i] = Math.round(v * 100) / 100;
  }
  return { heights: out, shoreline, scale: Math.round(scale * 1000) / 1000, ratio: landRatioOf(out) };
}
