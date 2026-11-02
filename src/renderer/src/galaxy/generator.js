// galaxy/generator.js —— 示例星系生成器（**整包移植自原型 SP-1025 `core/generator.ts` + `topology.ts` + `metrics.ts`**，2026-11-02）
//
// 为什么要有它：司天一直只在“用户已有数据”上套美术（4 个星域 / 10 颗星），而原型的银河观感来自
// `generateGalaxy()` —— 盘/螺旋采样 × 120 节点 × kNN 航道 × 量化自验。没有这一步，密度差一个数量级，
// 怎么调颜色都不像（2026-11-02 对照群星截图后确认）。
//
// 本模块是**纯函数**（无 DOM、无 store、无 Vue），Node 可直接测：
//   generateGalaxy(params) → { nodes, edges, regions, metrics, report, params }
//   toSiTianEntities(gen, opts) → { domains, galaxies, lanes }（司天的 star_domain / galaxy / 航道形状）
//
// 移植纪律：**公式与常量一字不改**（`sampleShape` 的 u^1.4 / 对数螺线、kNN 的 k 随 cap 缩放、
// 环边预算 n/6、切分圆内才阻挡的 Gabriel 判据…）。改了就等于又抄成自己的版本。
//
// 种子只走注入的 mulberry32；生成是原子的（调用方一条 undo 收掉）。

import { sampleDomainShape } from '../utils/galaxyLayout.js';

// ────────────────────────────────────────────────────────────────────────────
// 一、确定性随机（原型 core/prng.ts 逐行移植）
// ────────────────────────────────────────────────────────────────────────────

/** mulberry32：32 位种子 → [0,1) 均匀分布 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 原型 Rng 的最小等价物（next / range / int / pick / gauss / shuffle） */
export class Rng {
  constructor(seed) { this.next01 = mulberry32(seed); }
  next() { return this.next01(); }
  range(min, max) { return min + (max - min) * this.next01(); }
  int(n) { return Math.floor(this.next01() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  /** Box–Muller 近似：四枚均匀数叠加中心化（原型就是这么写的，别改成真高斯） */
  gauss(mu, sigma) {
    const u = this.next01() + this.next01() + this.next01() + this.next01() - 2;
    return mu + sigma * u * 1.732;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 二、参数与常量（原型 presetParams / INTERIOR_RHO / ROOT_RHO_MAX）
// ────────────────────────────────────────────────────────────────────────────

/** 生成盘的世界尺寸（司天画布以 (0,0) 为心；原型是 1600×1000 的正坐标世界） */
export const GEN_WORLD = { width: 1800, height: 1400 };

/** 势力腹地占椭圆盘的比例；超过它的是“未探索边域”（不属于任何势力） */
export const INTERIOR_RHO = 0.7;
/** 形态模板的根候选上限（根铺在腹地内圈，保证势力质心不越判据线） */
export const ROOT_RHO_MAX = 0.45;

/** 三组预设（与原型同参数；A=群星观感默认档） */
export function presetParams(group = 'A') {
  const base = { clusterSpread: 150, minDistance: 30, margin: 80, shape: 'spiral', arms: 3 };
  if (group === 'B') return { ...base, seed: 20261024, nodeCount: 30, clusterCount: 1, edgeRule: 'knn', edgeDegreeCap: 3 };
  if (group === 'C') return { ...base, seed: 20261024, nodeCount: 300, clusterCount: 8, edgeRule: 'degree', edgeDegreeCap: 8 };
  return { ...base, seed: 20261024, nodeCount: 120, clusterCount: 4, edgeRule: 'knn', edgeDegreeCap: 5 };
}

/** 参数校验（原型 validateParams 的同口径，只改报错前缀） */
export function validateParams(p) {
  const shape = p.shape || 'disc';
  const checks = [
    [Number.isInteger(p.seed), 'seed 必须是整数'],
    [Number.isInteger(p.nodeCount) && p.nodeCount >= 1 && p.nodeCount <= 2000, 'nodeCount 必须是 1~2000 的整数'],
    [Number.isInteger(p.clusterCount) && p.clusterCount >= 1 && p.clusterCount <= p.nodeCount, 'clusterCount 必须是 1~nodeCount 的整数'],
    [p.clusterSpread > 0, 'clusterSpread 必须 > 0'],
    [p.minDistance > 0, 'minDistance 必须 > 0'],
    [p.edgeRule === 'knn' || p.edgeRule === 'degree', 'edgeRule 必须是 knn 或 degree'],
    [Number.isInteger(p.edgeDegreeCap) && p.edgeDegreeCap >= 1 && p.edgeDegreeCap <= 32, 'edgeDegreeCap 必须是 1~32 的整数'],
    [p.margin >= 0 && p.margin * 2 < GEN_WORLD.width && p.margin * 2 < GEN_WORLD.height, 'margin 过大，生成区域为空'],
    [['disc', 'spiral', 'ring'].includes(shape), 'shape 必须是 disc / spiral / ring'],
  ];
  for (const [ok, msg] of checks) if (!ok) throw new Error(`生成参数非法：${msg}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 三、区域生长（原型 core/territory.ts 的 growRegions / factionWeights）
// ────────────────────────────────────────────────────────────────────────────

/** 每势力权重：[0.8, 1.35]，种子确定 —— 大树 claim 更远，版图不对称 */
export function factionWeights(count, rng) {
  return Array.from({ length: count }, () => 0.8 + rng.next() * 0.55);
}

/** 贪心 max-min 选根：第一根取最靠盘心的，之后每次取离已选根最远的 */
function pickRoots(nodes, count, rng, rootRhoMax) {
  const pool = nodes.filter((n) => n.rho <= rootRhoMax);
  if (!pool.length) return [];
  pool.sort((a, b) => a.rho - b.rho || String(a.id).localeCompare(String(b.id)));
  const roots = [pool[0]];
  while (roots.length < count && roots.length < pool.length) {
    let best = null;
    let bestD = -1;
    for (const n of pool) {
      if (roots.includes(n)) continue;
      const d = Math.min(...roots.map((r) => Math.hypot(r.x - n.x, r.y - n.y))) * (1 + (rng.next() - 0.5) * 0.05);
      if (d > bestD) { bestD = d; best = n; }
    }
    if (!best) break;
    roots.push(best);
  }
  return roots;
}

/** 加权 Prim 式生长：每个腹地节点归给「离它最近的已归属节点」所属势力 */
export function growRegions(nodes, factionCount, weights, rng, interiorRho, rootRhoMax = ROOT_RHO_MAX) {
  const roots = pickRoots(nodes, factionCount, rng, rootRhoMax);
  const weightOrder = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
  const factionOf = new Map();
  const rootFaction = [];
  roots.forEach((r, idx) => {
    const faction = idx < factionCount ? idx : weightOrder[(idx - factionCount) % 2].i;
    factionOf.set(r.id, faction);
    rootFaction.push({ id: r.id, faction, x: r.x, y: r.y, w: weights[faction] });
  });
  const assignedPts = rootFaction.map((r) => ({ x: r.x, y: r.y, faction: r.faction, w: r.w }));
  const remaining = nodes.filter((n) => n.rho <= interiorRho && !factionOf.has(n.id));
  const total = remaining.length;
  for (let guard = 0; guard < total + 8; guard++) {
    if (!remaining.length) break;
    let bestIdx = -1;
    let bestFaction = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const n = remaining[i];
      for (const a of assignedPts) {
        const cost = Math.hypot(a.x - n.x, a.y - n.y) / a.w;
        if (cost < bestCost) { bestCost = cost; bestIdx = i; bestFaction = a.faction; }
      }
    }
    if (bestIdx < 0) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    factionOf.set(chosen.id, bestFaction);
    assignedPts.push({ x: chosen.x, y: chosen.y, faction: bestFaction, w: weights[bestFaction] });
  }
  return { factionOf, roots: rootFaction.map(({ id, faction }) => ({ id, faction })) };
}

// ────────────────────────────────────────────────────────────────────────────
// 四、航道网络（原型 core/topology.ts 逐段移植）
// ────────────────────────────────────────────────────────────────────────────

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(a) {
    let root = this.parent.get(a) ?? a;
    if (root !== a) { root = this.find(root); this.parent.set(a, root); }
    return root;
  }
  add(a) { if (!this.parent.has(a)) this.parent.set(a, a); }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

function candidatesKnn(nodes, k) {
  const pairs = new Map();
  for (const a of nodes) {
    const order = nodes
      .filter((b) => b !== a)
      .map((b) => ({ b, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, k);
    for (const { b, d } of order) {
      const key = pairKey(a.id, b.id);
      if (!pairs.has(key)) pairs.set(key, [a.id < b.id ? a.id : b.id, a.id < b.id ? b.id : a.id, d]);
    }
  }
  return [...pairs.values()];
}

function candidatesGabriel(nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = d / 2;
      let blocked = false;
      for (const c of nodes) {
        if (c === a || c === b) continue;
        if (Math.hypot(c.x - mx, c.y - my) < r - 1e-9) { blocked = true; break; }
      }
      if (!blocked) out.push([a.id, b.id, d]);
    }
  }
  return out;
}

/** Tarjan 割点（迭代式）：拿掉后图会碎裂的节点 = 航道咽喉 */
export function articulationNodeIds(ids, pairs) {
  const adj = new Map();
  for (const id of ids) adj.set(id, []);
  for (const [a, b] of pairs) { adj.get(a)?.push(b); adj.get(b)?.push(a); }
  const disc = new Map();
  const low = new Map();
  const result = new Set();
  let timer = 0;
  for (const start of ids) {
    if (disc.has(start)) continue;
    const stack = [{ node: start, parent: null, iter: 0 }];
    disc.set(start, timer); low.set(start, timer); timer += 1;
    let rootChildren = 0;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.iter < neighbors.length) {
        const next = neighbors[frame.iter];
        frame.iter += 1;
        if (next === frame.parent) continue;
        if (disc.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), disc.get(next)));
        } else {
          if (frame.parent === null) rootChildren += 1;
          disc.set(next, timer); low.set(next, timer); timer += 1;
          stack.push({ node: next, parent: frame.node, iter: 0 });
        }
      } else {
        stack.pop();
        const parent = frame.parent;
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
          if (low.get(frame.node) >= disc.get(parent) && disc.get(parent) > 0) result.add(parent);
        }
      }
    }
    if (rootChildren >= 2) result.add(start);
  }
  return result;
}

/** 建航道：knn/Gabriel 候选 → 按长度贪心（守度上限）→ 2 跳补环（禁交叉）→ 分量桥接 */
export function buildLanes(input, params, rng) {
  const nodes = input.map((n) => ({ ...n, deg: 0 }));
  const cap = Math.max(1, Math.floor(params.edgeDegreeCap));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const accepted = new Set();
  const pairs = [];
  const addPair = (aId, bId) => {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b || a === b) return false;
    if (a.deg >= cap || b.deg >= cap) return false;
    const key = pairKey(aId, bId);
    if (accepted.has(key)) return false;
    accepted.add(key);
    a.deg += 1;
    b.deg += 1;
    pairs.push(aId < bId ? [aId, bId] : [bId, aId]);
    return true;
  };

  let candidates;
  if (params.edgeRule === 'knn') {
    const k = Math.min(cap, Math.max(2, Math.round(cap / 2) - 1));
    candidates = candidatesKnn(nodes, k);
  } else {
    candidates = candidatesGabriel(nodes);
  }
  candidates.sort((p, q) => p[2] - q[2]);
  for (const [a, b] of candidates) addPair(a, b);

  const posById = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const segList = [];
  const refreshSeg = (aId, bId) => {
    const a = posById.get(aId);
    const b = posById.get(bId);
    segList.push([a.x, a.y, b.x, b.y]);
  };
  for (const [a, b] of pairs) refreshSeg(a, b);
  const ccw = (ax, ay, bx, by, cx, cy) => (by - ay) * (cx - ax) - (bx - ax) * (cy - ay) > 0;
  const crossesExisting = (aId, bId) => {
    const a = posById.get(aId);
    const b = posById.get(bId);
    for (const [x1, y1, x2, y2] of segList) {
      if (ccw(a.x, a.y, b.x, b.y, x1, y1) !== ccw(a.x, a.y, b.x, b.y, x2, y2)
        && ccw(x1, y1, x2, y2, a.x, a.y) !== ccw(x1, y1, x2, y2, b.x, b.y)) return true;
    }
    return false;
  };

  const adjacency = new Map();
  for (const [a, b] of pairs) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  let loopEdgeCount = 0;
  const loopBudget = Math.floor(nodes.length / 6);
  const order = rng.shuffle(nodes.map((n) => n.id));
  for (const uId of order) {
    if (loopEdgeCount >= loopBudget) break;
    const u = byId.get(uId);
    if (u.deg >= cap) continue;
    const twoHop = new Set();
    for (const mid of adjacency.get(uId) ?? []) {
      for (const v of adjacency.get(mid) ?? []) {
        if (v !== uId && !(adjacency.get(uId) ?? new Set()).has(v)) twoHop.add(v);
      }
    }
    if (!twoHop.size) continue;
    const cand = [...twoHop]
      .map((v) => ({ v, d: Math.hypot(u.x - byId.get(v).x, u.y - byId.get(v).y) }))
      .sort((p, q) => p.d - q.d);
    for (const { v } of cand) {
      if (crossesExisting(uId, v)) continue;
      if (addPair(uId, v)) {
        loopEdgeCount += 1;
        refreshSeg(uId, v);
        adjacency.get(uId).add(v);
        adjacency.get(v).add(uId);
        break;
      }
    }
  }

  const uf = new UnionFind();
  nodes.forEach((n) => uf.add(n.id));
  for (const [a, b] of pairs) uf.union(a, b);
  let bridgeCount = 0;
  for (let guard = 0; guard < nodes.length; guard++) {
    const roots = new Set(nodes.map((n) => uf.find(n.id)));
    if (roots.size <= 1) break;
    let best = null;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a.deg >= cap) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (b.deg >= cap) continue;
        if (uf.find(a.id) === uf.find(b.id)) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!best || d < best.d) best = { a: a.id, b: b.id, d };
      }
    }
    if (!best || !addPair(best.a, best.b)) break;
    uf.union(best.a, best.b);
    bridgeCount += 1;
  }

  const isolatedIds = nodes.filter((n) => n.deg === 0).map((n) => n.id);
  const roots = new Set(nodes.map((n) => uf.find(n.id)));
  return {
    pairs,
    report: {
      candidateCount: candidates.length,
      loopEdgeCount,
      bridgeCount,
      components: Math.max(1, roots.size),
      isolatedIds,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 五、量化指标（原型 core/metrics.ts 的 computeMetrics，输入改成 {nodes, edges, params}）
// ────────────────────────────────────────────────────────────────────────────

export function computeMetrics({ nodes, edges, minDistance }) {
  const nodeCount = nodes.length;
  let overlapPairs = 0;
  const minDist = Math.max(minDistance || 0, 1e-9);
  if (minDist > 0 && nodeCount > 1) {
    const cell = Math.max(minDist, 8);
    const buckets = new Map();
    const keyOf = (x, y) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    for (const n of nodes) {
      const k = keyOf(n.x, n.y);
      const list = buckets.get(k);
      if (list) list.push(n); else buckets.set(k, [n]);
    }
    const checked = new Set();
    for (const n of nodes) {
      const bx = Math.floor(n.x / cell);
      const by = Math.floor(n.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = buckets.get(`${bx + dx}:${by + dy}`);
          if (!list) continue;
          for (const m of list) {
            if (m === n) continue;
            const pk = pairKey(n.id, m.id);
            if (checked.has(pk)) continue;
            checked.add(pk);
            if (Math.hypot(n.x - m.x, n.y - m.y) < minDist) overlapPairs += 1;
          }
        }
      }
    }
  }
  const deg = new Map();
  for (const n of nodes) deg.set(n.id, 0);
  for (const e of edges) {
    const a = e[0] ?? e.from;
    const b = e[1] ?? e.to;
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
  }
  let maxDegree = 0;
  let degreeSum = 0;
  for (const v of deg.values()) { if (v > maxDegree) maxDegree = v; degreeSum += v; }
  const avgDegree = nodeCount ? degreeSum / nodeCount : 0;

  const parent = new Map();
  for (const n of nodes) parent.set(n.id, n.id);
  const find = (a) => {
    let r = parent.get(a);
    while (r !== parent.get(r)) r = parent.get(r);
    let c = a;
    while (parent.get(c) !== r) { const nx = parent.get(c); parent.set(c, r); c = nx; }
    return r;
  };
  for (const e of edges) {
    const a = e[0] ?? e.from;
    const b = e[1] ?? e.to;
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const components = nodeCount === 0 ? 0 : new Set(nodes.map((n) => find(n.id))).size;

  const clusterCounts = new Map();
  for (const n of nodes) {
    const c = n.cluster;
    if (typeof c === 'number' && Number.isFinite(c)) clusterCounts.set(c, (clusterCounts.get(c) ?? 0) + 1);
  }
  const clusterShare = clusterCounts.size
    ? [...clusterCounts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v / Math.max(1, nodeCount))
    : [];
  return { nodeCount, overlapPairs, avgDegree, maxDegree, clusterShare, components, edgeCount: edges.length };
}

// ────────────────────────────────────────────────────────────────────────────
// 六、生成主流程（原型 attemptGenerate + generateGalaxy 的自验/重试）
// ────────────────────────────────────────────────────────────────────────────

const NAME_PREFIX = ['苍', '霜', '瀚', '汐', '岚', '曜', '珀', '璃', '烬', '澜', '岑', '湮', '霄', '璇', '岫', '溟', '昭', '翳', '昀', '皎'];
const NAME_SUFFIX_BY_TYPE = {
  default: ['川', '屿', '湾', '壤', '汀'],
  capital: ['域', '都', '川'],
  station: ['岬', '环', '碕'],
  gateway: ['门', '枢'],
};
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 区域配色：金角旋转取色（原型 regionColor 同公式） */
function regionColor(index) {
  const hue = (index * 137.508 + 210) % 360;
  return hslToHex(hue / 360, 0.55, 0.6);
}
function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function placeNodes(p, rng) {
  const cx = 0;
  const cy = 0;
  const rx = GEN_WORLD.width / 2 - p.margin - 20;
  const ry = GEN_WORLD.height / 2 - p.margin - 20;
  const shape = p.shape || 'disc';
  const arms = p.arms || 2 + rng.int(2);
  const weights = factionWeights(p.clusterCount, rng);
  const pts = [];
  const cell = Math.max(p.minDistance, 8);
  const buckets = new Map();
  const addToBucket = (pt) => {
    const k = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`;
    const list = buckets.get(k);
    if (list) list.push(pt); else buckets.set(k, [pt]);
  };
  const tooClose = (x, y) => {
    const bx = Math.floor(x / cell);
    const by = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${bx + dx}:${by + dy}`);
        if (!list) continue;
        for (const m of list) if (Math.hypot(m.x - x, m.y - y) < p.minDistance) return true;
      }
    }
    return false;
  };
  const lo = -rx - 20;
  const hiX = rx + 20;
  const loY = -ry - 20;
  const hiY = ry + 20;
  for (let i = 0; i < p.nodeCount; i++) {
    let ok = false;
    for (let attempt = 0; attempt < 200 && !ok; attempt++) {
      const s = sampleDomainShape(shape, rx, ry, () => rng.next(), arms);
      const x = cx + s.x + rng.gauss(0, p.clusterSpread / 10);
      const y = cy + s.y + rng.gauss(0, p.clusterSpread / 10);
      if (x < lo || x > hiX || y < loY || y > hiY) continue;
      if (tooClose(x, y)) continue;
      const rawRho = Math.hypot(x / rx, y / ry);
      const inner = shape === 'ring' ? 0.52 : shape === 'spiral' ? 0.16 : 0;
      const rho = Math.max(0, Math.min(1, (rawRho - inner) / (1 - inner)));
      const pt = { id: `n${i + 1}`, x, y, rho };
      pts.push(pt);
      addToBucket(pt);
      ok = true;
    }
    if (!ok) throw new Error(`第 ${i + 1} 个节点在 200 次拒绝采样内未能满足 minDistance=${p.minDistance}`);
  }
  return { pts, weights };
}

function attemptGenerate(p) {
  const rng = new Rng(p.seed >>> 0);
  const { pts, weights } = placeNodes(p, rng);
  const grown = growRegions(pts, p.clusterCount, weights, rng, INTERIOR_RHO, ROOT_RHO_MAX);
  // 每个势力都必须有成员（否则这个势力在图上是个空色块）
  for (let f = 0; f < p.clusterCount; f++) {
    if (![...grown.factionOf.values()].includes(f)) {
      throw new Error(`势力 ${f} 在腹地内没有成员（腹地过小或簇数过多）`);
    }
  }
  const rawNodes = pts.map((pt) => ({ id: pt.id, x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 }));
  const lanes = buildLanes(rawNodes, { edgeRule: p.edgeRule, edgeDegreeCap: p.edgeDegreeCap }, rng);

  const degree = new Map(rawNodes.map((n) => [n.id, 0]));
  for (const [a, b] of lanes.pairs) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const posById = new Map(rawNodes.map((n) => [n.id, n]));
  const primaryRoot = new Map();
  for (const r of grown.roots) {
    if (!primaryRoot.has(r.faction)) {
      const rp = posById.get(r.id);
      primaryRoot.set(r.faction, { x: rp.x, y: rp.y });
    }
  }
  const capitalIds = new Set();
  for (let f = 0; f < p.clusterCount; f++) {
    const anchor = primaryRoot.get(f);
    let best = null;
    let bestScore = -Infinity;
    for (const n of rawNodes) {
      if (grown.factionOf.get(n.id) !== f) continue;
      const distRoot = anchor ? Math.hypot(anchor.x - n.x, anchor.y - n.y) : 0;
      const score = (degree.get(n.id) ?? 0) * 100 - distRoot * 0.5;
      if (score > bestScore) { bestScore = score; best = n.id; }
    }
    if (best) capitalIds.add(best);
  }
  const articulation = articulationNodeIds(rawNodes.map((n) => n.id), lanes.pairs);
  const usedNames = new Set();
  const nodes = pts.map((pt, i) => {
    const id = pt.id;
    let type;
    if (capitalIds.has(id)) type = 'capital';
    else if (articulation.has(id) && (degree.get(id) ?? 0) >= 3) type = 'station';
    else {
      const r = rng.next();
      type = r < 0.12 ? 'station' : r < 0.16 ? 'gateway' : 'default';
    }
    const suffixPool = NAME_SUFFIX_BY_TYPE[type] ?? NAME_SUFFIX_BY_TYPE.default;
    let name = `${rng.pick(NAME_PREFIX)}${rng.pick(suffixPool)}`;
    // 防重：撞了就补序数，**一直补到不撞为止**（原型只补一次，120 节点时实测会重名 9 个）
    let ordinal = usedNames.size;
    while (usedNames.has(name)) {
      name = `${rng.pick(NAME_PREFIX)}${rng.pick(suffixPool)}${CN_NUM[Math.min(ordinal, 10)] ?? ordinal}`;
      ordinal += 1;
    }
    usedNames.add(name);
    const cluster = grown.factionOf.get(id);
    return {
      id,
      x: rawNodes[i].x,
      y: rawNodes[i].y,
      name,
      type,
      cluster: cluster === undefined ? null : cluster,
      rho: pt.rho,
    };
  });
  const regions = [];
  for (let c = 0; c < p.clusterCount; c++) {
    regions.push({
      id: `r${c + 1}`,
      name: `第${CN_NUM[c + 1] ?? c + 1}星域`,
      nodeIds: nodes.filter((n) => n.cluster === c).map((n) => n.id),
      color: regionColor(c),
    });
  }
  return { nodes, edges: lanes.pairs, regions, params: p };
}

/**
 * 执行生成：内部自验（nodeCount 精确 / overlapPairs=0 / maxDegree ≤ cap / 连通），
 * 不达标换种子偏移重试 ≤3 次，仍不行就报“参数无解”（与原型同口径）。
 */
export function generateGalaxy(pIn) {
  const p = { ...presetParams('A'), ...(pIn || {}) };
  validateParams(p);
  const reasons = [];
  for (let offset = 0; offset < 3; offset++) {
    const withOffset = { ...p, seed: (p.seed + offset * 7919) >>> 0 };
    let content;
    try {
      content = attemptGenerate(withOffset);
    } catch (err) {
      reasons.push(`种子偏移 ${offset}: ${err.message}`);
      continue;
    }
    const m = computeMetrics({ nodes: content.nodes, edges: content.edges, minDistance: p.minDistance });
    if (m.nodeCount === p.nodeCount && m.overlapPairs === 0 && m.maxDegree <= p.edgeDegreeCap) {
      const wantConnected = p.edgeDegreeCap >= 3 && p.nodeCount >= 12;
      if (!wantConnected || m.components === 1) {
        return { ...content, metrics: m, report: { seedOffset: offset, reasons } };
      }
      reasons.push(`种子偏移 ${offset}: 分量数 ${m.components} > 1`);
      continue;
    }
    if (m.overlapPairs > 0) reasons.push(`种子偏移 ${offset}: 重叠对 ${m.overlapPairs}`);
    if (m.maxDegree > p.edgeDegreeCap) reasons.push(`种子偏移 ${offset}: 最大度 ${m.maxDegree} > 上限`);
  }
  throw new Error(`参数无解：三次种子偏移均未达标。原因：${reasons.join('；') || '未知'}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 七、转成司天的实体形状（star_domain / galaxy / hyperlane）
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} gen `generateGalaxy()` 的返回
 * @param {{worldId?:string, idPrefix?:string}} [opts]
 * @returns {{domains:Array, galaxies:Array, lanes:Array, summary:object}}
 */
export function toSiTianEntities(gen, opts = {}) {
  const prefix = opts.idPrefix || `sample_${gen.params.seed}`;
  const worldId = opts.worldId || null;
  const domainIdOf = new Map();
  const domains = gen.regions.map((r, i) => {
    const members = gen.nodes.filter((n) => r.nodeIds.includes(n.id));
    const cx = members.reduce((a, n) => a + n.x, 0) / Math.max(1, members.length);
    const cy = members.reduce((a, n) => a + n.y, 0) / Math.max(1, members.length);
    const id = `${prefix}_d${i + 1}`;
    domainIdOf.set(r.id, id);
    return {
      id,
      name: r.name,
      layer: 'star_domain',
      parentId: worldId,
      coordinate: { x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100 },
      userMoved: true,
      factionColor: r.color,
      tags: ['sample'],
      sourcePath: '',
      draft: true,
    };
  });
  const clusterToDomain = new Map(gen.regions.map((r, i) => [i, domains[i].id]));
  // 未探索边域（ρ>INTERIOR_RHO）的星在原型里不属于任何势力；司天的星域视图按 parentId 聚簇，
  // 挂到世界上的星**不会被画出来**（layoutGalaxies 里 `if (!parentDomain) continue`）。
  // 所以这里给它们兜底：归到**最近的星域**（视觉上落在领土边上，符合"边域属最近势力"的直觉）。
  const centroidOf = new Map();
  gen.regions.forEach((r, i) => {
    const members = gen.nodes.filter((n) => r.nodeIds.includes(n.id));
    const cx = members.reduce((a, n) => a + n.x, 0) / Math.max(1, members.length);
    const cy = members.reduce((a, n) => a + n.y, 0) / Math.max(1, members.length);
    centroidOf.set(i, { x: cx, y: cy });
  });
  const nearestRegion = (x, y) => {
    let best = 0;
    let bestD = Infinity;
    for (const [i, c] of centroidOf) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const galaxies = gen.nodes.map((n, i) => {
    const cluster = n.cluster === null ? nearestRegion(n.x, n.y) : n.cluster;
    return {
      id: `${prefix}_g${i + 1}`,
      name: n.name,
      layer: 'galaxy',
      parentId: clusterToDomain.get(cluster) ?? worldId,
      coordinate: { x: n.x, y: n.y },
      userMoved: true,
      tags: ['sample', n.type],
      sourcePath: '',
      draft: true,
    };
  });
  const galaxyIdOf = new Map(gen.nodes.map((n, i) => [n.id, galaxies[i].id]));
  const clusterOf = new Map(gen.nodes.map((n) => [n.id, n.cluster]));
  const lanes = gen.edges.map(([a, b], i) => {
    const ca = clusterOf.get(a);
    const cb = clusterOf.get(b);
    return {
      id: `auto_${prefix}_l${i + 1}`,
      fromId: galaxyIdOf.get(a),
      toId: galaxyIdOf.get(b),
      type: ca !== null && ca === cb ? 'local' : 'cross_domain',
    };
  });
  return {
    domains,
    galaxies,
    lanes,
    summary: {
      seed: gen.params.seed,
      shape: gen.params.shape,
      domains: domains.length,
      stars: galaxies.length,
      lanes: lanes.length,
      crossDomainLanes: lanes.filter((l) => l.type === 'cross_domain').length,
      metrics: gen.metrics,
    },
  };
}
