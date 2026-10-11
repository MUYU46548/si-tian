// utils/voronoiBatch.js — **批量铺底**的纯几何层（B 方案：一键把一块大陆切成 N 个省份）
//
// ── 为什么是 Voronoi ──────────────────────────────────────────────────────
// 暮雨的最终目标：一张底图上「少说也要切四五百块省份」。逐个手切 = 400 次精确点击，不可行。
// Voronoi（泰森多边形）正是 EU4 那类「程序生成省份格」的连续几何对应物：
//   ① 每个 cell 是凸多边形 → 形状自然、不会长出尖刺；
//   ② 相邻 cell **共用同一条边** → 省份之间天然无缝、无缝可对；
//   ③ 「在大陆里点 N 个点 → 一次成型」——这正是「播种」的心智模型。
//
// 🔴 **不用 d3-delaunay，也不用三角形**：Delaunay 只是为了拿「谁和谁相邻」，而
//    cell 的**定义**本身就是「到本 seed 比到任何别的 seed 都近的点集」，
//    即 `∩_{j≠i} 半平面(i,j)`。逐点半平面裁剪直接算出精确的凸 cell，
//    没有外心、没有共圆退化、没有 Bowyer–Watson 的浮点裂缝。
//    代价是每 cell O(n) 次裁剪；用「按距离递增 + 提前终止」把它压回 O(邻居数)：
//    cell ⊆ 圆(s, R)（R = 当前 cell 顶点到 s 的最大距离），任何 dist(s,m) ≥ 2R 的 m
//    的垂直平分线都在 R 之外 → **不可能切到这个 cell**，可以安全 break（精确，非近似）。
//
// 🔴 **本文件不 import 任何裸模块**（与 polygonBool.js 同一条纪律）：
//    布尔引擎由调用方注入；这里只有纯几何 + 索引。
//
// 坐标系：世界坐标（y 向下与向上都不影响 —— 全程只用「距离」与「象限」判断）。

import { multiBBox, pointInMulti } from './polygonBool';

// ══════════════════════════════════════════════════════════════════════════
// 一、确定性随机（同一 seed 必须给出同一批种子点 → 用例可复现、用户可"再来一次"）
// ══════════════════════════════════════════════════════════════════════════

export function makeRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 二、播种（抖动网格）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 目标块数 → 网格行列数（按包围盒长宽比分配，避免长条地图上 cell 被拉成细条）。
 * @param target 目标块数（> 0）
 */
export function gridShapeFor(bbox, target) {
  const w = Math.max((bbox.maxX - bbox.minX), 1e-6);
  const h = Math.max((bbox.maxY - bbox.minY), 1e-6);
  const n = Math.max(1, Math.round(target));
  const cols = Math.max(1, Math.round(Math.sqrt(n * (w / h))));
  const rows = Math.max(1, Math.round(n / cols));
  return { cols, rows };
}

/**
 * 抖动网格种子点：规则网格 + 每个点在格内随机偏移 `jitter`（0 = 纯网格）。
 * 为什么要抖动：纯网格的 Voronoi 全是直角方格（一眼"机器切的"）；抖动后边界自然，
 * 但**不会**出现纯随机的疏密不均（每个格恰好一个点 = 面积大致均匀）。
 */
export function jitteredGridSeeds(bbox, cols, rows, rng, jitter = 0.62) {
  const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
  const dx = w / cols, dy = h / rows;
  const j = Math.min(Math.max(jitter, 0), 0.95);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kx = 0.5 + (rng() - 0.5) * 2 * j * 0.5;
      const ky = 0.5 + (rng() - 0.5) * 2 * j * 0.5;
      out.push({ x: bbox.minX + (c + kx) * dx, y: bbox.minY + (r + ky) * dy, col: c, row: r });
    }
  }
  return out;
}

/**
 * 自动播种：在**区域内部**铺 `target` 个点（区域只占包围盒一部分时按实测密度加密）。
 *
 * @param probe `makeRegionProbe()` 的返回值（提供 `inside(x,y)`）
 * @returns {{ seeds:Array<{x,y}>, attempt:number, requested:number }}
 */
export function autoSeedsInRegion(bbox, probe, target, { seed = 1, jitter = 0.62, maxAttempts = 5 } = {}) {
  const want = Math.max(1, Math.round(target));
  const rng = makeRng(seed);
  let factor = 1;
  let last = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { cols, rows } = gridShapeFor(bbox, want * factor);
    const cand = jitteredGridSeeds(bbox, cols, rows, rng, jitter);
    const inside = cand.filter((p) => probe.inside(p.x, p.y));
    last = inside;
    if (inside.length >= want) {
      // 多出来的按 rng 洗一遍再取前 want 个（否则永远偏向地图左上角）
      const pool = inside.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const k = Math.floor(rng() * (i + 1));
        const t = pool[i]; pool[i] = pool[k]; pool[k] = t;
      }
      return { seeds: pool.slice(0, want), attempt, requested: want };
    }
    factor *= 1.45;
  }
  return { seeds: last, attempt: maxAttempts, requested: want };
}

// ══════════════════════════════════════════════════════════════════════════
// 三、Voronoi（半平面裁剪）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 用「离 site 更近」的半平面裁一个凸多边形。
 * f(p) = |p−m|² − |p−s|²；f ≥ 0 ⟺ p 离 s 更近（或等距）。
 * @returns 新的顶点数组（`[x,y]`，未闭合）
 */
export function clipHalfPlane(cell, sx, sy, mx, my) {
  const n = cell.length;
  if (n < 3) return cell;
  const out = [];
  const f = (p) => (p[0] - mx) * (p[0] - mx) + (p[1] - my) * (p[1] - my)
    - (p[0] - sx) * (p[0] - sx) - (p[1] - sy) * (p[1] - sy);
  for (let i = 0; i < n; i++) {
    const a = cell[i], b = cell[(i + 1) % n];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** 去重（相邻重复 + 共线塌缩）：布尔引擎与渲染都不需要 1e-9 级的碎边 */
function tidyRing(ring, eps = 1e-7) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < eps && Math.abs(last[1] - p[1]) < eps) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) out.pop(); else break;
  }
  // 共线塌缩
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len > eps && Math.abs(cross) / len < eps) continue;      // b 在 a→c 上 → 丢掉
    res.push(b);
  }
  return res.length >= 3 ? res : out;
}

/** 闭合环（首尾同点），供布尔引擎使用 */
function closeRing(ring) {
  if (!ring.length) return [];
  return [...ring, [ring[0][0], ring[0][1]]];
}

/**
 * N 个 site → N 个 Voronoi cell（凸多边形，**相邻 cell 精确共边**）。
 *
 * @param sites `[{x,y}]`
 * @param bbox  所有 site 的包围盒（cell 会被裁到这个盒子外扩 padScale 倍的范围里）
 * @returns {{ rings:Array<Array<[number,number]>>, facets:number, empty:number }}
 *          `rings[i]` = 第 i 个 site 的 cell（闭合环）；cell 退化（<3 点）时为 null
 */
export function voronoiCells(sites, bbox, { padScale = 1.2 } = {}) {
  const list = (sites || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = list.length;
  const rings = new Array(n).fill(null);
  if (!n) return { rings, facets: 0, empty: 0, rect: null };
  const bb = bbox || multiBBox([[list.map((p) => [p.x, p.y])]]);
  const pad = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 1e-6) * padScale;
  const rect = [
    [bb.minX - pad, bb.minY - pad], [bb.maxX + pad, bb.minY - pad],
    [bb.maxX + pad, bb.maxY + pad], [bb.minX - pad, bb.maxY + pad],
  ];

  // 预排序：每个 site 的候选邻居按距离递增（一次 O(n² log n)，500 点 ≈ 40ms）
  const order = [];
  for (let i = 0; i < n; i++) {
    const s = list[i];
    const row = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = list[j].x - s.x, dy = list[j].y - s.y;
      row.push([dx * dx + dy * dy, j]);
    }
    row.sort((a, b) => a[0] - b[0]);
    order.push(row);
  }

  let facets = 0, empty = 0;
  for (let i = 0; i < n; i++) {
    const s = list[i];
    let cell = rect;
    let maxR = 0;
    for (const p of cell) maxR = Math.max(maxR, Math.hypot(p[0] - s.x, p[1] - s.y));
    for (const [d2, j] of order[i]) {
      const d = Math.sqrt(d2);
      if (d >= 2 * maxR) break;                       // 精确提前终止（见文件头）
      cell = clipHalfPlane(cell, s.x, s.y, list[j].x, list[j].y);
      facets++;
      if (cell.length < 3) break;
      maxR = 0;
      for (const p of cell) maxR = Math.max(maxR, Math.hypot(p[0] - s.x, p[1] - s.y));
    }
    const tidy = tidyRing(cell);
    if (tidy.length < 3) { empty++; continue; }
    rings[i] = closeRing(tidy);
  }
  return { rings, facets, empty, rect };
}

// ══════════════════════════════════════════════════════════════════════════
// 四、区域探针（加速：大部分 cell 不必调布尔引擎）
// ══════════════════════════════════════════════════════════════════════════
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 直接对每个 cell 调 `intersection(cell, 区域)`：实测真实底图（10525 点海岸线）**500 块要 11 秒**
// —— 代价几乎全在「扫描线要过一遍区域的全部 1 万条边」，与 cell 自身大小无关。
// 但其中**大部分 cell 跟海岸线根本不沾边**（要么整块在内陆、要么整块在海里）：
//   · 「这个 cell 的包围盒附近有没有区域的边？」——有索引，O(1)；
//   · 没有 → 整个 cell 要么全在区域内、要么全在区域外 → 一个内外判定即可定论。
//
// 🔴 判据是**保守的**：只要有任何一条边的**包围盒**与 cell 包围盒相交就返回 true（去调引擎）。
//    边的包围盒 ⊇ 边本身，所以「没有任何边靠近」⇒「cell 与区域边界不相交」⇒ 非全内即全外。
//    **不会出现"该切却跳过了"**；最坏情况只是白跑一次引擎（慢，但正确）。

export function makeRegionProbe(mp, { buckets = 64 } = {}) {
  const bb = multiBBox(mp);
  if (!bb) return null;
  const w = Math.max(bb.maxX - bb.minX, 1e-9), h = Math.max(bb.maxY - bb.minY, 1e-9);
  const side = Math.max(w, h) / Math.max(4, buckets);
  const cols = Math.max(1, Math.ceil(w / side) + 1);
  const rows = Math.max(1, Math.ceil(h / side) + 1);
  const grid = new Array(cols * rows);
  const boxes = [];                                  // 每条边的包围盒
  const colOf = (x) => Math.min(cols - 1, Math.max(0, Math.floor((x - bb.minX) / side)));
  const rowOf = (y) => Math.min(rows - 1, Math.max(0, Math.floor((y - bb.minY) / side)));
  for (const poly of mp) {
    for (const ring of poly || []) {
      for (let i = 0, len = ring.length; i < len; i++) {
        const a = ring[i], b = ring[(i + 1) % len];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        const box = { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
        const idx = boxes.push(box) - 1;
        const c0 = colOf(box.minX), c1 = colOf(box.maxX), r0 = rowOf(box.minY), r1 = rowOf(box.maxY);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const k = r * cols + c;
          if (!grid[k]) grid[k] = [];
          grid[k].push(idx);
        }
      }
    }
  }
  const hits = (box, list) => {
    for (const i of list) {
      const e = boxes[i];
      if (!(e.maxX < box.minX || e.minX > box.maxX || e.maxY < box.minY || e.minY > box.maxY)) return true;
    }
    return false;
  };
  return {
    bbox: bb,
    /** 点是否在区域内（奇偶规则；洞与飞地都对） */
    inside(x, y) { return pointInMulti(x, y, mp); },
    /**
     * cell 的包围盒附近**有没有**区域的边。
     * true = 必须走布尔引擎（保守）；false = cell 非全内即全外（可以省掉引擎）。
     */
    edgeNear(box) {
      const c0 = colOf(box.minX), c1 = colOf(box.maxX), r0 = rowOf(box.minY), r1 = rowOf(box.maxY);
      const nx = c1 - c0 + 1, ny = r1 - r0 + 1;
      if (nx * ny > cols * rows * 0.5) {              // 查询盒太大 → 直接全扫（慢一点但正确）
        for (const e of boxes) {
          if (!(e.maxX < box.minX || e.minX > box.maxX || e.maxY < box.minY || e.minY > box.maxY)) return true;
        }
        return false;
      }
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const list = grid[r * cols + c];
        if (list && hits(box, list)) return true;
      }
      return false;
    },
    stats: { edges: boxes.length, cols, rows, side },
  };
}

/** 环（`[[x,y],…]`，可闭合）的包围盒 */
export function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring || []) {
    if (!Array.isArray(p)) continue;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
