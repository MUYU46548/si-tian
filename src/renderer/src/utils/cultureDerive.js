// utils/cultureDerive.js — **文化 / 宗教 / 势力派生**（纯函数，零 DOM/Vue，Node 可测；2026-10-25）
//
// ── 目标（P0-4）────────────────────────────────────────────────────────────
//   暮雨拍板：**自动建势力 + 自动分归属，但永远保留手动编辑能力**。
//   这条链路此前完全没有：文化/宗教只有"从 .map 导入 + 笔刷涂"，势力只有手建。
//   一张自建底图切完省之后，用户面对的是 200~400 块没有文化、没有势力归属的空省。
//
// ── 做法（为什么这样做）────────────────────────────────────────────────────
//   ① **逐格文化**：在陆地格里用「最远点采样」选 k 个文化中心（确定性），
//      每格归最近中心 —— 得到连续的文化区（Voronoi 形状），而不是随机斑块。
//      选点不用 k-means（要迭代、结果依赖初始随机），最远点采样一次成型、可复现。
//   ② **宗教**：同样最远点采样，但**每个文化中心优先配一个宗教中心**
//      （真实世界的宗教多沿文化区扩散），不足的再用最远点补。
//   ③ **省份摘要**：每个省的形心 → 最近格 → 文化/宗教（省名着色与导出读的是这个字段）。
//   ④ **势力**：按文化区分组，一组一个势力；势力多时同一文化的省按形心 x 再切，
//      保证每块都有明确的种子与归属，且**不跨文化**（玩家能看出"这个国是那条河谷的"）。
//   ⑤ **可复现**：随机只来自 `makeRng(seed)`；同参数同结果。
//
//   ⚠️ 本模块**只算不写**：合并策略（只补空/覆盖）、undo、落盘都在 store；
//      纯函数只负责"理想答案"，由调用方决定哪些格该被改。

import { makeRng } from './voronoiBatch';

export const CULTURE_DERIVE_VERSION = 1;

export const CULTURE_NAMES = Object.freeze([
  '河谷', '高原', '海岸', '林地', '草原', '山地', '荒漠', '湖泽', '群岛', '北境', '南岭', '西陲',
]);
export const RELIGION_NAMES = Object.freeze([
  '日轮', '月影', '山神', '河灵', '祖灵', '星辰', '火焰', '丰收', '风暴', '静默', '潮汐', '霜誓',
]);
export const POLITY_NAMES = Object.freeze([
  '云', '岚', '朔', '烬', '澜', '岑', '曜', '霜', '陵', '汐', '岐', '沅',
]);
/** 12 色（与省份色板同量级；不去碰 scenarioPalette 的单源，这里只是生成用的稳定调色板） */
export const DERIVE_COLORS = Object.freeze([
  '#8fb9a8', '#c9a06a', '#9c8fb9', '#d08c7a', '#7aa5c9', '#b9b86a',
  '#c97aa5', '#6ab9b9', '#c9b48a', '#8ac97a', '#b98f6a', '#7a8fc9',
]);

const pointXY = (p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);

function pickFarthest(land, chosen, sx, sy) {
  // 选「到已选中心的最小距离」最大的格（平手取下标小的 → 确定性）
  let best = -1, bestD = -1;
  for (let idx = 0; idx < land.length; idx++) {
    const i = land[idx];
    let d = Infinity;
    for (let c = 0; c < chosen.length; c++) {
      const dx = sx[i] - sx[chosen[c]];
      const dy = sy[i] - sy[chosen[c]];
      const dd = dx * dx + dy * dy;
      if (dd < d) d = dd;
    }
    if (d > bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * 文化/宗教逐格派生。
 *
 * @param {object} input
 * @param {{points:Array, cellsX:number, cellsY:number, spacing?:number}} input.grid
 * @param {number[]|Float32Array} input.h 高度图（判陆地）
 * @param {number} [input.seaLevel=20]
 * @param {Array} [input.terrain] 省份多边形（只用来生成省摘要；可为空）
 * @param {object} input.params {seed, cultureCount, religionCount}
 * @returns {{cultures:Array, religions:Array, cultureGrid:Uint8Array, religionGrid:Uint8Array,
 *            provinceCulture:Object, stats:object}}
 */
export function deriveCultureLayers(input) {
  const { grid, h, terrain = [], params = {} } = input || {};
  const seaLevel = Number.isFinite(input && input.seaLevel) ? input.seaLevel : 20;
  const seed = Math.max(0, Math.floor(Number(params.seed) || 7));
  const cultureCount = Math.max(1, Math.min(12, Math.floor(Number(params.cultureCount) || 5)));
  const religionCount = Math.max(1, Math.min(12, Math.floor(Number(params.religionCount) || 4)));
  const n = grid && Array.isArray(grid.points) ? grid.points.length : 0;
  const cultureGrid = new Uint8Array(n);
  const religionGrid = new Uint8Array(n);
  if (!n || !h || h.length !== n) {
    return {
      cultures: [], religions: [], cultureGrid, religionGrid, provinceCulture: {},
      stats: { cells: n, landCells: 0, cultureCount: 0, religionCount: 0, assigned: 0 },
    };
  }
  const sx = new Float64Array(n), sy = new Float64Array(n);
  for (let i = 0; i < n; i++) { const p = pointXY(grid.points[i]); sx[i] = p[0]; sy[i] = p[1]; }

  const land = [];
  for (let i = 0; i < n; i++) if (h[i] >= seaLevel) land.push(i);
  if (!land.length) {
    return {
      cultures: [], religions: [], cultureGrid, religionGrid, provinceCulture: {},
      stats: { cells: n, landCells: 0, cultureCount: 0, religionCount: 0, assigned: 0 },
    };
  }

  const rng = makeRng(seed * 2654435761 + 91);
  const k = Math.min(cultureCount, land.length);
  const chosen = [land[Math.floor(rng() * land.length)]];
  while (chosen.length < k) {
    const next = pickFarthest(land, chosen, sx, sy);
    if (next < 0 || chosen.includes(next)) break;
    chosen.push(next);
  }
  const cultureCenters = chosen.map((idx, j) => ({
    i: j + 1,
    id: j + 1,
    name: (CULTURE_NAMES[(seed + j * 5) % CULTURE_NAMES.length] || '文化') + '文化',
    color: DERIVE_COLORS[(seed + j) % DERIVE_COLORS.length],
    center: { x: sx[idx], y: sy[idx] },
  }));

  // 逐格归最近中心
  const nearestOf = (i, seeds) => {
    let best = 1, bestD = Infinity;
    for (let j = 0; j < seeds.length; j++) {
      const dx = sx[i] - sx[seeds[j]], dy = sy[i] - sy[seeds[j]];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = j + 1; }
    }
    return best;
  };
  for (const i of land) cultureGrid[i] = nearestOf(i, chosen);

  // 宗教中心：每个文化中心优先落一个（宗教沿文化扩散）；不够再最远点补
  const religionSeeds = chosen.slice(0, Math.min(religionCount, chosen.length));
  while (religionSeeds.length < Math.min(religionCount, land.length)) {
    const next = pickFarthest(land, religionSeeds, sx, sy);
    if (next < 0 || religionSeeds.includes(next)) break;
    religionSeeds.push(next);
  }
  const religions = religionSeeds.map((idx, j) => ({
    i: j + 1,
    id: j + 1,
    name: RELIGION_NAMES[(seed + j * 7) % RELIGION_NAMES.length] || '信仰',
    color: DERIVE_COLORS[(seed + j + 5) % DERIVE_COLORS.length],
    center: { x: sx[idx], y: sy[idx] },
    // 宗教与"最近的文化中心"绑定（导出/UI 可显示归属）
    culture: cultureGrid[idx] || 1,
  }));
  for (const i of land) religionGrid[i] = nearestOf(i, religionSeeds);

  // 省份摘要：形心 → 最近格（用网格索引直接取，避免再算一遍最近点）
  const provinceCulture = {};
  if (Array.isArray(terrain) && terrain.length && grid.cellsX && grid.cellsY) {
    const box = gridBox(grid);
    for (const prov of terrain) {
      if (!prov || prov.kind === 'sea') continue;
      const c = centroidOf(prov);
      if (!c) continue;
      let i = nearestIndex(grid, box, c.x, c.y);
      // 形心落在海里（角上的省、海岸省都可能）：退到最近的**陆格**，否则该省会没文化
      if (i < 0 || !cultureGrid[i]) {
        i = nearestLandCell(i, land, sx, sy) ?? i;
      }
      if (i < 0) continue;
      const cid = cultureGrid[i] || 0;
      const rid = religionGrid[i] || 0;
      const cu = cultureCenters.find((x) => x.id === cid) || null;
      const re = religions.find((x) => x.id === rid) || null;
      provinceCulture[prov.id] = {
        cultureId: cid,
        culture: cu ? cu.name : '',
        cultureColor: cu ? cu.color : '',
        religionId: rid,
        religion: re ? re.name : '',
        religionColor: re ? re.color : '',
      };
    }
  }

  return {
    cultures: cultureCenters,
    religions,
    cultureGrid,
    religionGrid,
    provinceCulture,
    stats: {
      cells: n,
      landCells: land.length,
      cultureCount: cultureCenters.length,
      religionCount: religions.length,
      assigned: land.length,
      cultureSizes: countSizes(cultureGrid, cultureCenters.length),
      religionSizes: countSizes(religionGrid, religions.length),
    },
  };
}

/**
 * 势力方案：按文化区分组；势力多于文化时，同一文化按形心 x 切成几块。
 *
 * @param {Array} terrain 省份数组
 * @param {object} provinceCulture deriveCultureLayers 的产物
 * @param {{seed:number, polityCount:number}} params
 * @returns {{polities:Array<{id,name,color}>, ownerByProvince:Object, stats:object}}
 */
export function planPolities(terrain, provinceCulture, params = {}) {
  const seed = Math.max(0, Math.floor(Number(params.seed) || 7));
  const polityCount = Math.max(1, Math.min(12, Math.floor(Number(params.polityCount) || 4)));
  const provs = (Array.isArray(terrain) ? terrain : []).filter((p) => p && p.kind !== 'sea' && p.id);
  const groups = new Map();   // cultureId -> [{id, x}]
  for (const p of provs) {
    const rec = provinceCulture[p.id];
    const cid = rec && rec.cultureId ? rec.cultureId : 0;
    const c = centroidOf(p);
    if (!c) continue;
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push({ id: p.id, x: c.x, y: c.y });
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  if (!keys.length) return { polities: [], ownerByProvince: {}, stats: { polities: 0, assigned: 0 } };

  const byX = (a, b) => (a.x - b.x) || (a.y - b.y) || (a.id < b.id ? -1 : 1);
  const slots = [];   // {cultureKey, list}
  if (polityCount >= keys.length) {
    // 每个文化一个势力；还多出来的势力，从"省最多的文化"继续对半切（同一文化不跨区）
    for (const k of keys) slots.push({ cultureKey: k, list: (groups.get(k) || []).slice() });
    while (slots.length < polityCount) {
      let bi = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].list.length >= 2 && (bi < 0 || slots[i].list.length > slots[bi].list.length)) bi = i;
      }
      if (bi < 0) break;
      const s = slots[bi];
      const sorted = s.list.slice().sort(byX);
      const half = Math.ceil(sorted.length / 2);
      slots.splice(bi, 1,
        { cultureKey: s.cultureKey, list: sorted.slice(0, half) },
        { cultureKey: s.cultureKey, list: sorted.slice(half) });
    }
  } else {
    // 势力比文化还少：把文化按地理顺序（形心 x）合并成 polityCount 组
    const ordered = keys
      .map((k) => {
        const list = groups.get(k) || [];
        const x = list.reduce((a, p) => a + p.x, 0) / Math.max(1, list.length);
        return { k, x, list };
      })
      .sort((a, b) => (a.x - b.x) || (a.k - b.k));
    const bucket = Array.from({ length: polityCount }, () => []);
    ordered.forEach((o, i) => { bucket[i % polityCount].push(...o.list); });
    bucket.forEach((list) => slots.push({ cultureKey: null, list }));
  }

  const polities = [];
  const ownerByProvince = {};
  const used = new Set();
  slots.forEach((slot, j) => {
    const list = slot.list.slice().sort(byX);
    if (!list.length) return;
    const base = POLITY_NAMES[(seed + j * 5) % POLITY_NAMES.length] || '国';
    let name = base + '国';
    let n = 2;
    while (used.has(name)) { name = base + '国' + n++; }
    used.add(name);
    const id = `pol_${seed}_${j + 1}`;
    polities.push({ id, name, color: DERIVE_COLORS[(seed + j + 2) % DERIVE_COLORS.length] });
    for (const p of list) ownerByProvince[p.id] = id;
  });

  return {
    polities,
    ownerByProvince,
    stats: {
      polities: polities.length,
      assigned: Object.keys(ownerByProvince).length,
      unassigned: provs.length - Object.keys(ownerByProvince).length,
    },
  };
}

// ── 小工具 ────────────────────────────────────────────────────────────────
function countSizes(grid, maxId) {
  const out = new Array(maxId + 1).fill(0);
  for (let i = 0; i < grid.length; i++) { const v = grid[i]; if (v <= maxId) out[v]++; }
  return out.slice(1);
}
function gridBox(grid) {
  let minX = Infinity, minY = Infinity, dx = 1, dy = 1;
  const pts = grid.points || [];
  if (pts.length > 1) {
    const a = pointXY(pts[0]);
    const b = pointXY(pts[pts.length - 1]);
    minX = a[0]; minY = a[1];
    if (grid.cellsX > 1) dx = (b[0] - a[0]) / (grid.cellsX - 1) || 1;
    if (grid.cellsY > 1) dy = (b[1] - a[1]) / (grid.cellsY - 1) || 1;
  }
  return { minX, minY, dx, dy, cols: grid.cellsX || 0, rows: grid.cellsY || 0 };
}
function nearestIndex(grid, box, x, y) {
  if (!box.cols || !box.rows) return -1;
  let ci = Math.round((x - box.minX) / box.dx);
  let cj = Math.round((y - box.minY) / box.dy);
  ci = Math.min(box.cols - 1, Math.max(0, ci));
  cj = Math.min(box.rows - 1, Math.max(0, cj));
  return cj * box.cols + ci;
}
/** 形心落在海里时退到最近的陆格（角上的省、海岸省都会遇到） */
function nearestLandCell(i, land, sx, sy) {
  if (!land || !land.length) return null;
  if (i < 0) return land[0];
  const x = sx[i], y = sy[i];
  let best = land[0], bestD = Infinity;
  for (const c of land) {
    const dx = sx[c] - x, dy = sy[c] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
function centroidOf(prov) {
  const rings = Array.isArray(prov.rings) && prov.rings.length
    ? prov.rings
    : (Array.isArray(prov.points) ? [prov.points] : []);
  const pts = rings[0] || [];
  if (pts.length < 3) return null;
  let x = 0, y = 0;
  for (const p of pts) { const [px, py] = pointXY(p); x += px; y += py; }
  return { x: x / pts.length, y: y / pts.length };
}
