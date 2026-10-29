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

export { HEIGHT_TEMPLATES, TEMPLATE_IDS };

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
 * @returns {{h:Uint8Array, cellsX:number, cellsY:number, spacing:number, points:Array, template:string, seed:number|string, elapsedMs:number}}
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
  const cal = coverage > 0 ? calibrateCoverage(h, coverage) : { heights: h, shift: 0, ratio: landRatioOf(h) };
  h = cal.heights;

  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return {
    h,
    cellsX: lattice.cellsX,
    cellsY: lattice.cellsY,
    spacing: lattice.spacing,
    points: lattice.points,
    template: script,
    seed,
    landRatio: cal.ratio,
    seaShift: cal.shift,
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
 * **87% 陆地**（几乎没有海）。而司天这边"陆地占比"是用户能感知的产品参数（造陆面板里就有滑杆），
 * 也是本步判据的一部分（覆盖率 ±1%）。
 *
 * 做法：整体平移高度（**不改相对高差**），二分找到命中目标的平移量。平移而不是按比例缩放，
 * 因为缩放会把海岸线附近的坡度改掉（观感直接变），平移只是"海平面相对陆地动了一点"。
 *
 * @param {Uint8Array} heights
 * @param {number} target 0..1
 * @returns {{heights:Uint8Array, shift:number, ratio:number}}
 */
export function calibrateCoverage(heights, target) {
  const goal = Math.max(0, Math.min(1, Number(target)));
  if (!(goal > 0) || !heights || !heights.length) {
    return { heights, shift: 0, ratio: landRatioOf(heights) };
  }
  const ratioAt = (shift) => {
    let land = 0;
    for (let i = 0; i < heights.length; i++) if (heights[i] + shift >= 20) land++;
    return land / heights.length;
  };
  let lo = -120;
  let hi = 120;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ratioAt(mid) > goal) hi = mid;
    else lo = mid;
  }
  const shift = Math.round(((lo + hi) / 2) * 10) / 10;
  const out = new Uint8Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    const v = Math.round(heights[i] + shift);
    out[i] = v < 0 ? 0 : v > 100 ? 100 : v;
  }
  return { heights: out, shift, ratio: landRatioOf(out) };
}
