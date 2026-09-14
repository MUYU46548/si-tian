/**
 * placement.js — 智能放置算法（聚落 / 道路）
 *
 * 基于高度图数据计算最佳聚落位置和道路路径。纯函数，无副作用。
 *
 * ⚠️ 性能铁律（2026-09-14 重写）：真实行星高度图有 ~27,000 格，
 * 旧实现按「每格 × 全表」找邻居/水源（O(n²) ≈ 7 亿次 hypot），单次调用足以卡死 UI。
 * 现全部改为：**一次 O(n) 建空间哈希桶（桶边长 = 邻居半径）→ 邻居只查 3×3 桶**；
 * A* 的开放集改二叉堆（旧的 `open.includes()` + 线性找最小是 O(k²)）。
 * 任何在此文件新增的「按格遍历」都必须走 buildSpatialIndex，禁止写双重全表循环。
 */
import { SEA_LEVEL } from './heightMath';

const DEFAULT_SPACING = 14.4;
const SEARCH_RADIUS = 100;   // 智能聚落：在点击点周边多大范围内找最优位（世界单位）
const MAX_ROAD_STEP_FACTOR = 1.5; // 公路相邻点最大间距 = spacing × 该系数
const MAX_ROAD_HEIGHT_DIFF = 15;  // 道路允许的单步高差（避开陡崖）

const xOf = (p) => (Array.isArray(p) ? p[0] : p.x);
const yOf = (p) => (Array.isArray(p) ? p[1] : p.y);

/**
 * 空间哈希索引：O(n) 建桶，邻居查询只扫 3×3 桶 + 距离过滤。
 * 桶边长取邻居半径 → 任何距离 ≤ 半径的点必然落在相邻桶内。
 */
function buildSpatialIndex(grid) {
  const pts = (grid && grid.points) || [];
  const spacing = (grid && grid.spacing) || DEFAULT_SPACING;
  const n = pts.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = xOf(pts[i]);
    py[i] = yOf(pts[i]);
  }
  const maxStep = spacing * MAX_ROAD_STEP_FACTOR;
  const buckets = new Map();
  // 整数键：格子坐标可能为负 → 先平移再拼（(gx+off)*K + (gy+off)）
  const keyOf = (gx, gy) => (gx + 32768) * 65536 + (gy + 32768);
  for (let i = 0; i < n; i++) {
    const k = keyOf(Math.floor(px[i] / maxStep), Math.floor(py[i] / maxStep));
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push(i);
  }

  const neighborCache = new Array(n);
  /** 与 i 距离 ≤ maxStep 的邻居（结果缓存，A* 中同一格可能被多次访问） */
  function neighbors(i) {
    let cached = neighborCache[i];
    if (cached) return cached;
    const gx = Math.floor(px[i] / maxStep);
    const gy = Math.floor(py[i] / maxStep);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = buckets.get(keyOf(gx + dx, gy + dy));
        if (!b) continue;
        for (const j of b) {
          if (j === i) continue;
          if (Math.hypot(px[j] - px[i], py[j] - py[i]) <= maxStep) out.push(j);
        }
      }
    }
    neighborCache[i] = out;
    return out;
  }

  return { n, px, py, spacing, maxStep, neighbors };
}

/** 网格中所有水点索引（h < SEA_LEVEL）——距离水源查询的候选集 */
function waterIndices(heightmap, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (heightmap[i] < SEA_LEVEL) out.push(i);
  return out;
}

/**
 * 计算网格点坡度（邻居高度差均值；无邻居返回 0）
 */
export function calculateSlope(heightmap, grid, index) {
  const idx = buildSpatialIndex(grid);
  if (index < 0 || index >= idx.n) return 0;
  const h = heightmap[index];
  const nbs = idx.neighbors(index);
  if (!nbs.length) return 0;
  let maxDiff = 0;
  for (const j of nbs) {
    const diff = Math.abs(heightmap[j] - h);
    if (diff > maxDiff) maxDiff = diff;
  }
  return maxDiff / nbs.length;
}

/**
 * 找最近水源（海洋或河流）的距离，单位为格步数
 */
export function distanceToWater(heightmap, grid, index) {
  const idx = buildSpatialIndex(grid);
  if (index < 0 || index >= idx.n) return 999;
  let minDist = Infinity;
  for (const w of waterIndices(heightmap, idx.n)) {
    const d = Math.hypot(idx.px[w] - idx.px[index], idx.py[w] - idx.py[index]);
    if (d < minDist) minDist = d;
  }
  return minDist === Infinity ? 999 : minDist / idx.spacing;
}

/**
 * 智能聚落放置：点击某点，在周边找最优位置
 * 规则：避开海洋(h<SEA_LEVEL)和高山(h>70)，偏好中等海拔、靠近水源、远离陡坡
 *
 * 复杂度：O(n) 建索引 + O(候选数 × 水点数)；候选只取点击半径内的格，
 * 不做「全表逐格算水源距离」（旧实现正是这里卡死）。
 */
export function findOptimalBurgPosition(heightmap, grid, clickX, clickY) {
  const idx = buildSpatialIndex(grid);
  const { n, px, py, spacing } = idx;
  const water = waterIndices(heightmap, n);

  // 先按点击距离筛候选（O(n)），再对候选做重评分
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const h = heightmap[i];
    if (h < SEA_LEVEL || h > 70) continue;
    const clickDist = Math.hypot(px[i] - clickX, py[i] - clickY);
    if (clickDist > SEARCH_RADIUS) continue;
    candidates.push({ i, h, clickDist });
    if (candidates.length >= 400) break; // 上限保护：极端稠密网格下不失控
  }

  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const { i, h, clickDist } = c;
    let score = -Math.abs(h - 40) * 0.1; // 偏好中等海拔

    let minWater = Infinity;
    for (const w of water) {
      const d = Math.hypot(px[w] - px[i], py[w] - py[i]);
      if (d < minWater) minWater = d;
    }
    const waterDist = minWater === Infinity ? 999 : minWater / spacing;
    if (waterDist < 5) score += (5 - waterDist) * 8; // 靠近水源加分

    const nbs = idx.neighbors(i);
    let slope = 0;
    if (nbs.length) {
      let maxDiff = 0;
      for (const j of nbs) {
        const diff = Math.abs(heightmap[j] - h);
        if (diff > maxDiff) maxDiff = diff;
      }
      slope = maxDiff / nbs.length;
    }
    score -= slope * 0.5;      // 避开陡坡
    score -= clickDist * 0.05; // 偏好靠近点击点

    if (score > bestScore) {
      bestScore = score;
      best = { index: i, x: px[i], y: py[i], h, score };
    }
  }
  return best;
}

// ===== 二叉最小堆（A* 开放集；f 值数组 + 节点数组，惰性删除）=====
function heapPush(heap, f, node) {
  heap.push([f, node]);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p][0] <= heap[i][0]) break;
    const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
    i = p;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
      if (m === i) break;
      const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      i = m;
    }
  }
  return top;
}

/**
 * 道路生成：A* 路径（偏好等高线 / 缓坡）
 * 从 startIdx 到 endIdx，返回途经的网格点索引数组（不可达返回 []）
 *
 * 复杂度：O(n) 建索引 + O(E log V) A*（旧实现为 O(n²) 邻居预计算 + O(k²) 开放集）
 */
export function generateRoadPath(heightmap, grid, startIdx, endIdx) {
  const idx = buildSpatialIndex(grid);
  const { n, px, py, neighbors } = idx;
  if (startIdx < 0 || endIdx < 0 || startIdx >= n || endIdx >= n || startIdx === endIdx) return [];

  const cameFrom = new Int32Array(n).fill(-1);
  const gScore = new Float32Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  const heap = [];
  const hDist = (i) => Math.hypot(px[endIdx] - px[i], py[endIdx] - py[i]);

  gScore[startIdx] = 0;
  heapPush(heap, hDist(startIdx), startIdx);

  while (heap.length) {
    const top = heapPop(heap);
    const current = top[1];
    if (closed[current]) continue; // 惰性删除：旧条目直接跳过
    if (current === endIdx) {
      const path = [];
      let c = endIdx;
      while (c !== -1) { path.push(c); c = cameFrom[c]; }
      return path.reverse();
    }
    closed[current] = 1;

    for (const nb of neighbors(current)) {
      if (closed[nb]) continue;
      const hDiff = Math.abs(heightmap[nb] - heightmap[current]);
      if (hDiff > MAX_ROAD_HEIGHT_DIFF) continue; // 避开陡崖
      const dist = Math.hypot(px[nb] - px[current], py[nb] - py[current]);
      const tentative = gScore[current] + dist + hDiff * 2;
      if (tentative < gScore[nb]) {
        cameFrom[nb] = current;
        gScore[nb] = tentative;
        heapPush(heap, tentative + hDist(nb), nb);
      }
    }
  }
  return []; // 无路径
}

/**
 * 最近网格点查找（世界坐标 → 索引）
 */
export function findNearestGridPoint(heightmap, grid, worldX, worldY) {
  const idx = buildSpatialIndex(grid);
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < idx.n; i++) {
    const d = Math.hypot(idx.px[i] - worldX, idx.py[i] - worldY);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}
