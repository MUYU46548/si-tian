// utils/reliefIcons.js — Relief Icons 地貌图标散布（P0-1）
//
// 参考 Azgaar FMG 的 Relief editor：沿笔刷路径自然散布山脉/树木/沙漠/岩石图标。
//
// 硬约束（提示词明确要求）：
//   1. **确定性**：同 seed + 同输入路径 ⇒ 完全相同的结果。禁止 Math.random 决定位置；
//      抖动/旋转/尺寸全部来自整数哈希（hash2），可复现、可测试、撤销后重做结果一致。
//   2. **不重叠**：候选点先过空间网格桶（cellSize 桶）查邻居，与已有图标距离不足则换哈希盐重试，
//      重试用尽则跳过该点（宁可稀疏也不叠）。
//   3. **有界**：单次笔刷散布有上限 MAX_PER_STROKE，防止长拖拽卡死。

/** 4 种地貌类型（icon 名必须同时存在于 Icon.vue 与 canvasIcon.js） */
export const RELIEF_TYPES = [
  { key: 'mountain', label: '山脉', icon: 'mountain', color: '#8D7B68' },
  { key: 'tree', label: '树木', icon: 'tree', color: '#4F9D69' },
  { key: 'cacti', label: '沙漠', icon: 'cactus', color: '#C7A45B' },
  { key: 'rock', label: '岩石', icon: 'rock', color: '#8A8F98' },
];

export const RELIEF_TYPE_MAP = Object.fromEntries(RELIEF_TYPES.map(t => [t.key, t]));

/** 密度档位 → 间距系数（密度的本质是"每平方像素图标数"，等价于间距缩放） */
export const RELIEF_DENSITY = {
  low: { label: '稀疏', factor: 1.5 },
  medium: { label: '中等', factor: 1 },
  high: { label: '密集', factor: 0.62 },
};

export const DEFAULT_RELIEF_PARAMS = {
  type: 'mountain',
  size: 24,              // 16 – 48
  spacing: 30,           // 沿路径的最小间距（世界单位）
  density: 'medium',
  randomRotation: true,  // 随机旋转 0–359°
  seed: 1,
};

export const MAX_PER_STROKE = 1500;
const SIZE_JITTER = 0.28;     // 尺寸随机浮动 ±28%
const LATERAL_JITTER = 0.3;   // 垂直路径方向偏移比例（× spacing）
const MAX_TRIES = 6;          // 单点换盐重试次数（保证不重叠）

// ===== 确定性伪随机 =====

/** 32 位整数哈希（位置 + 盐 + seed → 稳定伪随机数） */
export function hash2(x, y, salt, seed = 0) {
  let h = (seed | 0) ^ 0x27d4eb2d;
  h = Math.imul(h ^ (salt | 0), 0x85ebca6b);
  h ^= Math.imul((x | 0) ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** [0,1) 确定性伪随机 */
export function rand01(x, y, salt, seed = 0) {
  return hash2(x, y, salt, seed) / 4294967296;
}

// ===== 空间网格桶（避免渲染/查重 O(n)） =====

export const RELIEF_CELL = 64;

export function reliefCellKey(cx, cy) {
  return `${cx},${cy}`;
}

/** 建网格桶：bucket[cellKey] = number[]（icons 的下标） */
export function buildReliefGrid(icons, cell = RELIEF_CELL) {
  const grid = new Map();
  for (let i = 0; i < icons.length; i++) {
    const it = icons[i];
    const k = reliefCellKey(Math.floor(it.x / cell), Math.floor(it.y / cell));
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(i);
  }
  return { cell, buckets: grid };
}

/** 查半径内图标下标（返回下标数组，可能重复，调用方自行去重或不关心） */
export function queryReliefGrid(gridIndex, icons, x, y, radius) {
  const out = [];
  if (!gridIndex) return out;
  const { cell, buckets } = gridIndex;
  const c0x = Math.floor((x - radius) / cell);
  const c1x = Math.floor((x + radius) / cell);
  const c0y = Math.floor((y - radius) / cell);
  const c1y = Math.floor((y + radius) / cell);
  const r2 = radius * radius;
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cy = c0y; cy <= c1y; cy++) {
      const arr = buckets.get(reliefCellKey(cx, cy));
      if (!arr) continue;
      for (const i of arr) {
        const it = icons[i];
        const dx = it.x - x;
        const dy = it.y - y;
        if (dx * dx + dy * dy <= r2) out.push(i);
      }
    }
  }
  return out;
}

/**
 * 查矩形（含外扩 margin）内的图标下标 —— 渲染视口裁剪用，避免大数量时逐点 O(n)。
 */
export function queryReliefGridRect(gridIndex, icons, rect) {
  const out = [];
  if (!gridIndex || !rect) return out;
  const { cell, buckets } = gridIndex;
  const c0x = Math.floor(rect.minX / cell);
  const c1x = Math.floor(rect.maxX / cell);
  const c0y = Math.floor(rect.minY / cell);
  const c1y = Math.floor(rect.maxY / cell);
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cy = c0y; cy <= c1y; cy++) {
      const arr = buckets.get(reliefCellKey(cx, cy));
      if (!arr) continue;
      for (const i of arr) out.push(i);
    }
  }
  return out;
}

// ===== 确定性散布 =====
let _idSeq = 0;

/** 生成图标 id（不参与"确定性"，仅用于 undo 定位；不影响散布结果） */
export function nextReliefId() {
  _idSeq += 1;
  return `ri-${Date.now().toString(36)}-${_idSeq}`;
}

/**
 * 沿折线路径确定性散布地貌图标。
 *
 * @param {Array<{x:number,y:number}>} path 笔刷经过的世界坐标折线（相邻点间距建议 ≤ spacing）
 * @param {object} [params] DEFAULT_RELIEF_PARAMS 的子集
 * @param {Array} [existing] 已有图标（用于不重叠判定，按空间网格加速）
 * @returns {Array<{id,type,x,y,size,rotation}>} 新增的图标（不含 existing）
 */
export function scatterAlongPath(path, params = {}, existing = []) {
  const p = { ...DEFAULT_RELIEF_PARAMS, ...params };
  const pts = (path || []).filter(q => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  if (pts.length === 0) return [];

  const densityFactor = (RELIEF_DENSITY[p.density] || RELIEF_DENSITY.medium).factor;
  const step = Math.max(4, (Number(p.spacing) || 30) * densityFactor);
  const size = Math.min(48, Math.max(16, Number(p.size) || 24));
  const seed = p.seed | 0;

  // 已有图标进网格桶（同时把本次新增也并进去，实现"新增之间也不重叠"）
  const occupied = existing ? existing.slice() : [];
  const grid = buildReliefGrid(occupied);
  const toBucket = (icon) => {
    const k = reliefCellKey(Math.floor(icon.x / grid.cell), Math.floor(icon.y / grid.cell));
    let arr = grid.buckets.get(k);
    if (!arr) { arr = []; grid.buckets.set(k, arr); }
    arr.push(occupied.length - 1);
  };

  const out = [];
  let walk = 0;          // 已走过的弧长
  // 相位对齐：沿用调用方传入的 startOffset，让多段拖动的间距连续
  // 第一个落点落在「全局弧长 = step 的整数倍」处 → 换算成本段内的局部弧长
  const startOffset = Number(p.startOffset) || 0;
  let nextAt = step * Math.ceil(startOffset / step) - startOffset;
  let segIndex = 0;      // 段序号（参与哈希，保证不同段不重复）

  for (let i = 0; i < pts.length - 1 && out.length < MAX_PER_STROKE; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy; // 法线
    const ny = ux;

    while (nextAt <= walk + len && out.length < MAX_PER_STROKE) {
      const t = (nextAt - walk) / len;
      const bx = a.x + dx * t;
      const by = a.y + dy * t;
      const gx = Math.round(bx);
      const gy = Math.round(by);

      let placed = null;
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        const salt = segIndex * 977 + attempt * 131 + 7;
        const lateral = (rand01(gx, gy, salt, seed) - 0.5) * 2 * LATERAL_JITTER * step;
        const cand = { x: bx + nx * lateral, y: by + ny * lateral };
        const candSize = Math.max(16, Math.min(48, size * (1 + (rand01(gx, gy, salt + 101, seed) - 0.5) * 2 * SIZE_JITTER)));
        const minDist = (candSize + size) * 0.42;
        const hits = queryReliefGrid(grid, occupied, cand.x, cand.y, minDist);
        // 自身尺寸也要与邻居体积相关：命中即换盐重试
        if (hits.length === 0) {
          placed = {
            id: nextReliefId(),
            type: p.type,
            x: cand.x,
            y: cand.y,
            size: candSize,
            rotation: p.randomRotation ? Math.round(rand01(gx, gy, salt + 211, seed) * 360) : 0,
          };
          break;
        }
      }
      if (placed) {
        out.push(placed);
        occupied.push(placed);
        toBucket(placed);
      }
      nextAt += step;
    }

    walk += len;
    segIndex += 1;
  }

  return out;
}

/**
 * 擦除半径内的图标（右键拖动）。
 * @returns {{ remaining: Array, removed: Array }} removed 用于 undo 复原
 */
export function eraseInRadius(icons, x, y, radius) {
  const list = icons || [];
  const grid = buildReliefGrid(list);
  const idx = new Set(queryReliefGrid(grid, list, x, y, radius));
  if (idx.size === 0) return { remaining: list, removed: [] };
  const remaining = [];
  const removed = [];
  for (let i = 0; i < list.length; i++) {
    if (idx.has(i)) removed.push(list[i]);
    else remaining.push(list[i]);
  }
  return { remaining, removed };
}
