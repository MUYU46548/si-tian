// utils/riverWidths.js — 河道逐点宽度：**汇流台阶**与平滑后的流量对齐（纯函数；2026-10-27）
//
// ── 为什么需要它（用户 2026-10-27 的第 3 条缺口）────────────────────────────
// 「干流与支流汇合处没有越汇越宽」。数据上宽度其实是 `widthAt(flow)`（按汇流量算的），
// 但画到屏幕上**看不出台阶**，原因有两个，都在这一层：
//   ① 平滑（Chaikin）之后点数变 4 倍、且角点附近更密 —— 旧实现按**归一化下标**把流量
//      重采样到平滑后的点列上（`t = k/(n-1)`），台阶被摊平成一整条缓坡；
//   ② 全局归一化的宽度曲线把低流量段压得很扁：流量 40 → 80 只差 0.006 世界单位
//      （屏幕上 ~0.1px），等于没有台阶。
//
// 这一层只做两件**纯几何/纯数据**的事，别的都不碰：
//   · `flowAlongSmoothedPath`：把原始链上的逐点流量**按弧长最近段**投到平滑后的点列上
//     （位置对齐 = 台阶落在该落的地方，而不是被摊平）；
//   · `applyConfluenceSteps`：在流量**显著跳升**（汇流点）处给下游一个**宽度台阶**
//     （下游至少 = 上游 × factor，封顶 cap）—— 这是制图惯例：支流汇入，河立刻变宽。
//
// ⚠️ 台阶是"至少"不是"覆盖"：宽度仍以 `widthAt(flow)` 的绝对曲线为主（细支流保持细），
//    台阶只保证**在汇流处看得见变化**。
//
// 纯函数：不碰 DOM / store；Node 直接测（`scripts/tests/unit/test_river_widths.js`）。

/** 点 → 段的最近投影（返回 {seg, t, dist2}） */
function nearestOnPolyline(src, p) {
  let best = { seg: 0, t: 0, dist2: Infinity };
  for (let i = 1; i < src.length; i++) {
    const ax = src[i - 1].x, ay = src[i - 1].y;
    const dx = src[i].x - ax, dy = src[i].y - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-12 ? ((p.x - ax) * dx + (p.y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, py = ay + dy * t;
    const d2 = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
    if (d2 < best.dist2) best = { seg: i - 1, t, dist2: d2 };
  }
  return best;
}

/**
 * 把 `srcPoints` 上的逐点流量投到 `targetPoints`（通常是平滑后的点列）上。
 *
 * 为什么按**最近段**而不是下标比例：Chaikin 在角点附近更密、端点不动 —— 下标比例会把
 * "第 10 个点"错配到别处，汇流台阶就被抹成缓坡（这正是"看不出越汇越宽"的成因之一）。
 *
 * @param {Array<{x:number,y:number}>} targetPoints 目标点列（平滑后）
 * @param {Array<{x:number,y:number}>} srcPoints 原始点列
 * @param {number[]} srcFlows 与 srcPoints 等长的流量
 * @param {number} [fallback] 源数据不足时的兜底流量
 * @returns {number[]} 与 targetPoints 等长的流量
 */
export function flowAlongSmoothedPath(targetPoints, srcPoints, srcFlows, fallback = 1) {
  const tgt = Array.isArray(targetPoints) ? targetPoints : [];
  const src = Array.isArray(srcPoints) ? srcPoints : [];
  const fl = Array.isArray(srcFlows) ? srcFlows : [];
  const fb = Number.isFinite(fallback) ? fallback : 1;
  if (!tgt.length) return [];
  if (src.length < 2 || !fl.length) return tgt.map(() => fb);
  return tgt.map((p) => {
    const near = nearestOnPolyline(src, p);
    const a = Number(fl[near.seg]);
    const b = Number(fl[near.seg + 1]);
    const va = Number.isFinite(a) ? a : fb;
    const vb = Number.isFinite(b) ? b : va;
    return va + (vb - va) * near.t;
  });
}

/**
 * 汇流台阶：流量**显著跳升**处，下游宽度至少 = 上游 × `factor`。
 *
 * 判据（`jumpRatio`）：`flow[k] >= flow[k-1] * jumpRatio` 视为汇流（默认 1.6 ——
 * 一格内流量翻 1.6 倍只可能是支流汇入，不可能是平滑抖动）。
 *
 * @param {number[]} widths 逐点宽度（世界单位）
 * @param {number[]} flows 逐点流量（与 widths 等长）
 * @param {{factor?:number, jumpRatio?:number, cap?:number}} [opts]
 * @returns {number[]} 新数组（不改入参）；非递减、不超过 cap
 */
export function applyConfluenceSteps(widths, flows, opts = {}) {
  const w = Array.isArray(widths) ? widths.slice() : [];
  const f = Array.isArray(flows) ? flows : [];
  if (w.length < 2) return w;
  const factor = Number(opts.factor) > 1 ? Number(opts.factor) : 1.35;
  const jumpRatio = Number(opts.jumpRatio) > 1 ? Number(opts.jumpRatio) : 1.6;
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : Infinity;
  for (let k = 1; k < w.length; k++) {
    const prev = Number(w[k - 1]) || 0;
    let v = Number(w[k]) || 0;
    const fPrev = Number(f[k - 1]);
    const fCur = Number(f[k]);
    const junction = Number.isFinite(fPrev) && Number.isFinite(fCur)
      && fPrev > 0 && fCur >= fPrev * jumpRatio;
    if (junction) v = Math.max(v, prev * factor);
    // 下游不许比上游窄（汇流只会让水量变大；出现回缩就是采样抖动）
    if (v < prev) v = prev;
    w[k] = Math.min(cap, v);
  }
  return w;
}
