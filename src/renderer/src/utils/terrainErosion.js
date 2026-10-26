// utils/terrainErosion.js — **河成侵蚀（stream-power incision）**：按流向场把地形切出谷
//
// ── 为什么需要它（2026-10-25/26 实测结论，别重走）──────────────────────────────
//   造陆 v4 把地形换成 `terrainSynthesis` 之后，直接把 `traceRivers` 接上去，画出来是
//   **整片 45° 平行直线 + 半山腰断头**（`docs/assets/landmass-v4-20261025/rivers-rejected.png`）。
//   根因不是"追踪算法坏了"，而是**地形没有谷**：
//     · 合成地形的主体是"离岸距离场"（一个圆丘）→ 坡面均匀 → 水只能**平行**下流；
//     · 洼地填平会把一片格子抬到**同一个水位**（溢流点），等高格上 `traceRivers` 的兜底
//       是按格号走（+x/+y），于是出现**成片的对角线**。
//   真实地形的谷是**水自己切出来的**：流量大的地方切得深，切得深的地方吸来更多水
//   （正反馈），最后收敛成树枝状水系。本模块就是这条正反馈的最小实现。
//
// ── 做法（每一轮）──────────────────────────────────────────────────────────────
//   ① **复用 `traceRivers` 的流向场**（不写第二套 D8）：它输出的 `segments` 是
//      "每格 → 它的下游格"，逐段带 `flow`（汇流格数）与 `cell`（格号）；
//   ② 对每一段按**河流功率**下切：`Δh = k · A^0.45 · S^0.9`（A = 流量，S = 到下游的坡度），
//      并**按局部落差封顶**（最多切掉落差的 55%）：不封顶会切出比下游还低的坑，
//      下一轮水就流不出去（`traceRivers` 会把它当内流盆地整片丢掉）；
//   ③ 重复 N 轮：上一轮切出来的浅沟会捕获更多汇流 → 下一轮切得更深 → 树枝状水系。
//
//   ⚠️ 只改 `hm.h`（就地），不碰 `grid`、不写盘；`traceRivers` 的 `H` 是内部拷贝，
//      所以"算流向"与"改高度"之间没有隐藏耦合。
//   ⚠️ 确定性：没有随机量（`traceRivers` 内部也只用确定性排序）。

import { traceRivers } from './riverTrace';

/** 默认强度（每一轮的最大下切量，高度点） */
export const INCISE_STRENGTH = 2.2;
/** 每轮最多切掉"本格到下游落差"的比例（防止切出反坡坑） */
export const INCISE_MAX_DROP_FRAC = 0.55;
/** 流量指数（汇流面积的影响） */
export const INCISE_FLOW_EXP = 0.45;
/** 坡度指数 */
export const INCISE_SLOPE_EXP = 0.9;

/**
 * 按流向场下切地形。
 *
 * @param {{h:number[], grid:{points:Array, cellsX:number, cellsY:number, spacing:number}}} hm
 *   高度图（就地修改 `h`；`grid` 只读）
 * @param {{seaLevel?:number, isLand?:(x:number,y:number)=>boolean, iterations?:number,
 *          strength?:number, maxDropFrac?:number, onIteration?:(i:number, stats:object)=>void}} [opts]
 * @returns {{iterations:number, carved:number, cells:number, ms:number, perIteration:number[]}}
 *   `carved` = 累计下切的高度点总量（诊断/回执用）
 */
export function inciseByFlow(hm, opts = {}) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const out = { iterations: 0, carved: 0, cells: 0, ms: 0, perIteration: [] };
  if (!hm || !Array.isArray(hm.h) || !hm.grid || !Array.isArray(hm.grid.points)) return out;
  const n = hm.h.length;
  if (!n || hm.grid.points.length !== n) return out;

  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const iterations = Math.max(0, Math.min(6, Math.round(Number(opts.iterations) || 0)));
  if (!iterations) return out;
  const strength = Number.isFinite(opts.strength) ? Math.max(0, opts.strength) : INCISE_STRENGTH;
  const dropFrac = Number.isFinite(opts.maxDropFrac)
    ? Math.max(0.05, Math.min(0.9, opts.maxDropFrac)) : INCISE_MAX_DROP_FRAC;
  const isLand = typeof opts.isLand === 'function' ? opts.isLand : null;
  const spacing = Number(hm.grid.spacing) > 0 ? Number(hm.grid.spacing) : 14.4;

  // 格号 → 世界坐标 的反查表（`traceRivers` 的段只给两端坐标；这里按量化坐标查回格号，
  // 而不是假设 grid 是规则格 —— 规则性只在我们自己合成时成立，别把假设埋进算法）
  const keyOf = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const indexByPos = new Map();
  for (let i = 0; i < n; i++) {
    const p = hm.grid.points[i];
    const x = Array.isArray(p) ? p[0] : p && p.x;
    const y = Array.isArray(p) ? p[1] : p && p.y;
    if (Number.isFinite(x) && Number.isFinite(y)) indexByPos.set(keyOf(x, y), i);
  }

  for (let it = 0; it < iterations; it++) {
    // ① 流向场（**唯一实现**：与画布「自动河流」同一份 traceRivers）
    const traced = traceRivers(hm, {
      seaLevel,
      sourceHeight: seaLevel + 0.5,      // 让**所有**陆格参与流向场（不是只从高处起河）
      minPoints: 2,
      coalesce: false,
      isLand: isLand || undefined,
      sourceInlandCells: 0,
    });
    const segments = traced.segments || [];
    if (!segments.length) break;

    // ② 流量上界（归一化用本轮的分布，不用绝对公式 —— 同一份地形换个分辨率量纲就变）
    let maxFlow = 1;
    for (const s of segments) if (s.flow > maxFlow) maxFlow = s.flow;
    const flowNorm = (f) => Math.pow(Math.max(1, f) / maxFlow, INCISE_FLOW_EXP);

    // ③ 逐段下切（先把"要切多少"算完再统一应用：边算边切会让同一轮内的坡度互相污染）
    const carve = new Float64Array(n);
    let touches = 0;
    for (const s of segments) {
      const a = Number.isFinite(s.cell) ? s.cell : indexByPos.get(keyOf(s.x0, s.y0));
      if (!Number.isInteger(a) || a < 0 || a >= n) continue;
      const b = indexByPos.get(keyOf(s.x1, s.y1));
      if (!Number.isInteger(b) || b < 0 || b >= n || b === a) continue;
      const drop = hm.h[a] - hm.h[b];
      if (!(drop > 0)) continue;                  // 只切"确实往下流"的那一段
      const slope = drop / spacing;
      const want = strength * flowNorm(s.flow) * Math.pow(Math.min(1, slope * 6), INCISE_SLOPE_EXP);
      const cap = drop * dropFrac;
      const take = Math.max(0, Math.min(want, cap));
      if (take > 0) { carve[a] = Math.max(carve[a], take); touches++; }
    }
    let carved = 0;
    for (let i = 0; i < n; i++) {
      if (carve[i] <= 0) continue;
      // 不低于海平面（切穿了就是海，会把陆地占比打乱）
      const next = Math.max(seaLevel + 0.2, hm.h[i] - carve[i]);
      carved += hm.h[i] - next;
      hm.h[i] = Math.round(next * 100) / 100;
    }
    out.perIteration.push(Math.round(carved * 10) / 10);
    out.carved += carved;
    out.iterations++;
    out.cells = touches;
    if (typeof opts.onIteration === 'function') {
      try { opts.onIteration(it, { carved, segments: segments.length, maxFlow }); } catch (_) { /* 回调不许打断侵蚀 */ }
    }
    if (carved <= 0) break;
  }
  out.carved = Math.round(out.carved * 10) / 10;
  out.ms = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
  return out;
}
