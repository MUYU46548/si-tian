// utils/terrainPipeline.js — **地形生成的完整工序**（推演 → 排水骨架 → 丘陵 → 填洼 → 湖）
//
// ── 为什么要有这一层（2026-11-04）──────────────────────────────────────────────
//   产品里原来有两个"半条管线"：
//     · `synthesizeHeightmapFromTerrain`（按轮廓推演）只到"填洼 + 湖"；
//     · `landmass.generateLandmass`（造陆）在它之后又叠了 `scatterHills` + `erodeTerrain`。
//   于是"从已有轮廓生成地形"这条路**没有丘陵**，而实验证明**没有丘陵就没有 8 格尺度的
//   方向变化**（扇状度停在 0.83，参照 0.715）。
//
//   P2.1 的实测配方是：**分级河网骨架**（干支流）+ **多尺度丘陵**（打散平行坡面），
//   两者缺一：只有骨架 → 支流仍平行（0.821）；只有丘陵 → 河被切碎（0.83 → 短河 57%）。
//
//   本模块把这套配方收成**一条工序、一份实现**：实验量尺（`_audit_erosion.mjs`）
//   与产品（`scenarioEditing`）都调它 —— 量出来的数就是产品跑出来的数。
//
//   ⚠️ 默认行为不变：`hills: 0` 且不开排水选项时，输出与 `synthesizeHeightmapFromTerrain`
//      逐字节一致（老项目重生成不会自己变脸）。

import { synthesizeHeightmapFromTerrain, fillDepressions } from './terrainSynthesis.js';
import { scatterHills } from './terrainHills.js';
import { createFmgRandom } from './fmg/rng.js';
import { detectBasinLakes } from './lakes.js';

/** 丘陵参数（与造陆路径同一组；`count` 由调用方给，其余是形状） */
export const TERRAIN_HILLS = Object.freeze({
  rMin: 2.2, rMax: 8.5, ampMin: 1.2, ampMax: 6.5,
  // 2026-11-04：0.16 → 0.10。丘陵盆太多会把“湖”撒成一地小水洼（实测 16 处 / 415 格，
  // 其中多数 9~30 格的浅坑）；0.10 配下面的湖阈值 → 5 处 / 160 格，且保住一处 67 格的真盆地。
  basinRate: 0.10,
});

/** 分级河网的默认分级参数（P2.1 实测这一组：扇状度 0.750 / 入海口 286 / 最长 773） */
export const TERRAIN_DRAINAGE = Object.freeze({ depth: 4, branching: 3 });

/** 填洼的 ε（与 `terrainSynthesis` 内同口径：landSpan 的 1/2000 ≈ 0.04） */
const FILL_EPS = 0.04;

/**
 * 地形生成完整工序。
 *
 * @param {Array} terrain 轮廓（同 `synthesizeHeightmapFromTerrain`）
 * @param {object} opts  `synthesizeHeightmapFromTerrain` 的全部选项 + 下面两个：
 *   `hills` —— 丘陵数量（0 = 不撒；与造陆路径同一份 `scatterHills`）
 *   `drainageTree` / `drainageBasins` —— 排水骨架（见 `drainageBasins.js`）
 * @returns {object|null} 高度图（`h` 是 Array；带 `lakes`、`structure.hills`）
 */
export function synthesizeTerrain(terrain, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const hm = synthesizeHeightmapFromTerrain(terrain, o);
  if (!hm) return null;
  const count = Math.max(0, Math.floor(Number(o.hills) || 0));
  if (!count) return hm;
  const seaLevel = Number.isFinite(o.seaLevel) ? o.seaLevel : 20;
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY;
  const n = hm.h.length;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = hm.h[i] >= seaLevel ? 1 : 0;
  const rng = createFmgRandom(Number.isFinite(o.seed) ? o.seed : 7).next;
  const basinRate = Number.isFinite(o.hillBasinRate) ? o.hillBasinRate : TERRAIN_HILLS.basinRate;
  scatterHills(
    { h: hm.h, grid: { cellsX: cols, cellsY: rows, spacing: hm.grid.spacing } },
    { ...TERRAIN_HILLS, basinRate, count, seaLevel, rng },
  );
  // 丘陵会造新的浅盆：再填一次洼地（否则河在半路消失），并重新判湖
  const basins = [];
  const filled = fillDepressions(hm.h, land, cols, rows, seaLevel, FILL_EPS, basins);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = land[i] ? Math.round(filled[i] * 100) / 100 : seaLevel - 8;
  hm.h = out;
  // 湖的判定与 `terrainSynthesis` 共用一份实现
  // 湖阈值（2026-11-04 调）：小于 16 格或浅于 0.7 的“水洼”不算湖 —— 丘陵会造出大量这种浅坑，
  // 全算湖的话河会在半路被截成一段段（实测入湖 93 条 vs 36 条）。
  const lakes = detectBasinLakes(filled, basins, cols, rows, o.lakeOpts || { minArea: 16, minDepth: 0.7 });
  if (lakes.length) hm.lakes = lakes;
  else delete hm.lakes;
  if (hm.structure) hm.structure = { ...hm.structure, hills: count };
  return hm;
}
