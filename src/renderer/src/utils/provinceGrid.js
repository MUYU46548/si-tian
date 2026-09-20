// utils/provinceGrid.js — 省份「归属标签网格」纯函数层（Phase 3）
//
// 模型（skill `canvas-brush-integration` §7）：省份不再只靠多边形顶点编辑，而是
//   · `labels: Uint8Array(cols*rows)` —— **每格一个归属序号**，`0 = 无主`（海域 / 未划归）
//   · 序号 = `baseMaps[key].terrain[]` 的下标 + 1（**复用既有的省份定义表，不另建第二张表** ——
//     否则「多边形省份」与「网格省份」会变成两套事实源）
//   · 省界不由顶点给出，而是**差异边 → 链 → Chaikin 平滑**自动提取
//
// 为什么这套模型值得存在：轮廓走笔刷 = 用户不需要描点连线也能得到省界（§7 的核心论点）。
// 副作用是「删除省份必须重编号」——`labels` 里所有 > 被删序号的格子要减 1，否则标签会
// 指向不存在的省份（取色函数越界）。这类操作的 undo **必须记整表快照**，差量记录还原不了。
//
// 本模块是**纯函数**（不碰 store / DOM / 响应式），所以 Node 侧也能读；网格几何与高度图
// 共用同一套约定（origin 由内容包围盒推导并持久化，绝不跟随视口 —— 铁律 81）。

import { polygonArea, pointInPolygon } from './geometry';

export const DEFAULT_GRID_CELL = 14.4;

function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points || []) {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

export function gridCellCount(grid) {
  return (grid.cols || 0) * (grid.rows || 0);
}

/** 网格 → 世界：格 (c, r) 的中心点 */
export function cellCenter(grid, c, r) {
  return { x: grid.ox + (c + 0.5) * grid.cell, y: grid.oy + (r + 0.5) * grid.cell };
}

/** 世界 → 格：返回 { c, r }（可能越界，调用方自己判） */
export function cellAt(grid, x, y) {
  return { c: Math.floor((x - grid.ox) / grid.cell), r: Math.floor((y - grid.oy) / grid.cell) };
}

export function inGrid(grid, c, r) {
  return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows;
}

/**
 * 由内容包围盒推导网格几何（原点一次性定下来并持久化；四周留 extraCells 圈，
 * 让内容外缘也有地方涂 —— 与地形涂色网格同一策略，见铁律 89）。
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} bounds 无内容时给 null → 用 0 附近的默认范围
 */
export function makeGrid(bounds, { cell = DEFAULT_GRID_CELL, extraCells = 4 } = {}) {
  const b = bounds || { minX: -cell * 20, minY: -cell * 20, maxX: cell * 20, maxY: cell * 20 };
  const ox = b.minX - extraCells * cell;
  const oy = b.minY - extraCells * cell;
  const cols = Math.max(1, Math.ceil((b.maxX - ox) / cell) + extraCells);
  const rows = Math.max(1, Math.ceil((b.maxY - oy) / cell) + extraCells);
  return { cell, ox, oy, cols, rows };
}

/** 由省份定义表推导网格（无内容时退回默认范围） */
export function gridFromProvinces(provinces, opts = {}) {
  const pts = [];
  for (const p of provinces || []) if (p && Array.isArray(p.points)) pts.push(...p.points);
  return makeGrid(pts.length ? bboxOf(pts) : null, opts);
}

/**
 * 多边形 → 归属序号：格中心 even-odd 射线法。
 * **按面积降序、命中即停**：大省先落，小省不覆盖已有归属 —— 否则小多边形会在
 * 大多边形上啃出一个个洞（导入的 FMG 数据里小省多得多）。
 * 每多边形先做包围盒预筛，不进渲染循环（一次性）。
 * @returns {Uint8Array}
 */
export function rasterizeProvinces(provinces, grid) {
  const { cols, rows, cell, ox, oy } = grid;
  const labels = new Uint8Array(cols * rows);
  const order = (provinces || [])
    .map((p, i) => ({ idx: i + 1, pts: (p && p.points) || [], area: Math.abs(polygonArea((p && p.points) || [])) }))
    .filter(o => o.pts.length >= 3 && o.area > 0)
    .sort((a, b) => b.area - a.area);

  for (const o of order) {
    const bb = bboxOf(o.pts);
    if (!bb) continue;
    const c0 = Math.max(0, Math.floor((bb.minX - ox) / cell));
    const c1 = Math.min(cols - 1, Math.floor((bb.maxX - ox) / cell));
    const r0 = Math.max(0, Math.floor((bb.minY - oy) / cell));
    const r1 = Math.min(rows - 1, Math.floor((bb.maxY - oy) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (labels[i]) continue;
        if (pointInPolygon(ox + (c + 0.5) * cell, oy + (r + 0.5) * cell, o.pts)) labels[i] = o.idx;
      }
    }
  }
  return labels;
}

/**
 * 省界提取：格边 → 邻接表 → 走链 → 世界坐标点链。
 * 判据是**相邻格归属不同**（含「有主格 ↔ 网格外框」—— 否则贴着地图边缘的一段没有边界线）。
 * @returns {Array<Array<{x:number,y:number}>>} 若干条链（可能开口，也可能闭合）
 */
export function extractBorders(labels, grid) {
  const { cols, rows, cell, ox, oy } = grid;
  const adj = new Map();
  const push = (ax, ay, bx, by) => {
    const ka = ax + ',' + ay, kb = bx + ',' + by;
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push(kb);
    adj.get(kb).push(ka);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = labels[r * cols + c];
      if (c + 1 < cols && labels[r * cols + c + 1] !== v) push(c + 1, r, c + 1, r + 1);
      if (r + 1 < rows && labels[(r + 1) * cols + c] !== v) push(c, r + 1, c + 1, r + 1);
      if (c === 0 && v) push(c, r, c, r + 1);
      if (c === cols - 1 && v) push(c + 1, r, c + 1, r + 1);
      if (r === 0 && v) push(c, r, c + 1, r);
      if (r === rows - 1 && v) push(c, r + 1, c + 1, r + 1);
    }
  }

  const seen = new Set();
  const chains = [];
  const cap = 4 * cols * rows;          // 走链上限：邻接图度数异常时不至于死循环
  for (const [k, nbrs] of adj) {
    for (const n0 of nbrs) {
      const ek = k + '|' + n0;
      if (seen.has(ek)) continue;
      const chain = [[+k.split(',')[0], +k.split(',')[1]]];
      let cur = k, next = n0, steps = 0;
      while (steps++ < cap) {
        seen.add(cur + '|' + next);
        seen.add(next + '|' + cur);
        const p = next.split(',');
        chain.push([+p[0], +p[1]]);
        let nxt = null;
        for (const cand of adj.get(next) || []) {
          if (cand === cur) continue;
          if (seen.has(next + '|' + cand)) continue;
          nxt = cand;
          break;
        }
        if (!nxt) break;
        cur = next;
        next = nxt;
        if (next === k) break;
      }
      if (chain.length >= 3) chains.push(chain.map(([c, r]) => ({ x: ox + c * cell, y: oy + r * cell })));
    }
  }
  return chains;
}

/** Chaikin 圆角（0.75/0.25 取点）。直接 stroke 原始格边是锯齿，观感立刻降级。 */
export function chaikin(points, iters = 2) {
  let pts = (points || []).map(p => [p.x, p.y]);
  if (pts.length < 3) return (points || []).map(p => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iters; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts.map(([x, y]) => ({ x, y }));
}

/** 3×3 邻域众数（平滑笔刷）。众数不优于原值 → 保留原值。 */
export function majorityAt(labels, grid, c, r, fallback) {
  const cnt = {};
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const cc = c + dx, rr = r + dy;
      if (!inGrid(grid, cc, rr)) continue;
      const v = labels[rr * grid.cols + cc];
      if (!v) continue;
      cnt[v] = (cnt[v] || 0) + 1;
    }
  }
  const keys = Object.keys(cnt);
  if (!keys.length) return fallback;
  keys.sort((a, b) => cnt[b] - cnt[a]);
  if (fallback && cnt[fallback] >= cnt[keys[0]]) return fallback;
  return +keys[0];
}

/**
 * 一次笔刷落点（一格 dab）。返回**差量** `[[i, 旧值], ...]`（调用方累积成整笔一条 undo）。
 * falloff × strength < 0.25 的格子直接跳过 —— 硬边里也留过渡，但不涂到边缘 0 强度。
 */
export function stampBrush(labels, grid, { c, r, radius = 4, strength = 0.8, tool = 'paint', target = 0 }) {
  const changed = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const cc = c + dx, rr = r + dy;
      if (!inGrid(grid, cc, rr)) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const falloff = 1 - dist / (radius + 0.001);
      if (falloff * strength < 0.25) continue;
      const i = rr * grid.cols + cc;
      const old = labels[i];
      let nv = old;
      if (tool === 'paint') nv = target;
      else if (tool === 'erase') nv = 0;
      else if (tool === 'smooth') nv = majorityAt(labels, grid, cc, rr, old);
      if (nv !== old) { changed.push([i, old]); labels[i] = nv; }
    }
  }
  return changed;
}

/**
 * 自由轮廓（套索）：世界多边形 → 圈内的格全部划归 target。
 * 一笔成形、零次描点 —— 这是「涂」之外唯一值得有的轮廓入口。
 * @returns {Array<[number, number]>} 差量 `[[i, 旧值], ...]`
 */
export function lassoCells(labels, grid, worldPoly, target = 0) {
  const pts = (worldPoly || []).filter(p => p && isFinite(p.x) && isFinite(p.y));
  if (pts.length < 3) return [];
  const { cols, rows, cell, ox, oy } = grid;
  const bb = bboxOf(pts);
  const c0 = Math.max(0, Math.floor((bb.minX - ox) / cell));
  const c1 = Math.min(cols - 1, Math.floor((bb.maxX - ox) / cell));
  const r0 = Math.max(0, Math.floor((bb.minY - oy) / cell));
  const r1 = Math.min(rows - 1, Math.floor((bb.maxY - oy) / cell));
  const changed = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      if (labels[i] === target) continue;
      if (pointInPolygon(ox + (c + 0.5) * cell, oy + (r + 0.5) * cell, pts)) {
        changed.push([i, labels[i]]);
        labels[i] = target;
      }
    }
  }
  return changed;
}

/**
 * 删除某省份后的重编号（**就地**改 labels），两步缺一不可：
 *   ① 被删省份**自己的格置无主**（0）—— 否则它们会「继承」给顶替它序号的那个省份，
 *      等于把地盘白送给邻居（原型实测：漏这步时删完省份地图上那块地还在，只是换了主人）；
 *   ② 序号 > deletedIdx 的全部减 1（保持「序号 = 定义表下标 + 1」不变式）。
 * 🔴 两步都会改动「未被删除的格」→ 这类操作的 undo 必须记整表快照，差量记录还原不了。
 * @returns {{ cleared:number, renumbered:number }}
 */
export function renumberAfterDelete(labels, deletedIdx) {
  if (!deletedIdx) return { cleared: 0, renumbered: 0 };
  let cleared = 0, renumbered = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === deletedIdx) { labels[i] = 0; cleared++; }
    else if (labels[i] > deletedIdx) { labels[i] -= 1; renumbered++; }
  }
  return { cleared, renumbered };
}

export function countOwned(labels) {
  let n = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i]) n++;
  return n;
}

export function usedIndices(labels) {
  const s = new Set();
  for (let i = 0; i < labels.length; i++) if (labels[i]) s.add(labels[i]);
  return [...s].sort((a, b) => a - b);
}

/** 持久化：TypedArray 必须转普通数组（过 JSON 会退化成无 length 的对象 → 读回即废，铁律 83） */
export function serializeLabels(labels) {
  return Array.from(labels || []);
}

/**
 * 读回自愈：长度不符 / 元素超范围 / 不是数字 → 返回 null（调用方按省份多边形重建）。
 * 不要「尽力修补」——半坏的标签网格比没有更难看懂。
 */
export function deserializeLabels(raw, expectedLen) {
  if (!Array.isArray(raw) || raw.length !== expectedLen) return null;
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 255) return null;
    out[i] = v;
  }
  return out;
}

/** 校验并**就地修复**已有网格：几何自洽（cols*rows == 数据长度）且格宽一致，否则视为无效 */
export function normalizeStoredGrid(stored, provinces) {
  if (!stored || typeof stored !== 'object') return null;
  const { cols, rows, cell, ox, oy } = stored;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
  if (!(typeof cell === 'number' && isFinite(cell) && cell > 0)) return null;
  if (!(typeof ox === 'number' && isFinite(ox) && typeof oy === 'number' && isFinite(oy))) return null;
  const grid = { cols, rows, cell, ox, oy };
  const labels = deserializeLabels(stored.data, cols * rows);
  if (!labels) return null;
  // 序号越界（指向不存在的省份）→ 该格置无主，别让取色函数越界
  const maxIdx = (provinces || []).length;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxIdx) labels[i] = 0;
  return { grid, labels };
}
