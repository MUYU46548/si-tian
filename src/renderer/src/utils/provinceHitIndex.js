// utils/provinceHitIndex.js — 省份命中的**空间索引**（2026-10-23，第 1 件 1-a）
//
// ── 为什么要有这一层（实测，不是猜）────────────────────────────────────────
// `findProvinceAt` 原来是**全表线性扫描**：从数组末尾往前，逐个省 `pointInProvince`。
// 真实 200 省底图上实测 **20.4ms/次**；而「涂归属」每落一个采样点要查 **5 个偏移**，
// 于是一次 mousemove 固定付 **96.9ms**（帧统计里 p95 117ms、72/222 帧 >50ms）。
// 20ms 不是射线法慢（单省只要 0.10ms），是**每次都要把 200 个省的环重新分配 + 重新判嵌套**：
//   `pointInProvince` → `provinceRings`（新建包装对象）+ `ringSigns`（又要遍历环判嵌套）。
//
// 这一层做两件事，语义**逐字节不变**：
//   ① 建索引时把每个省的「环 + 嵌套符号 + 包围盒」算一次，热循环里直接复用；
//   ② 均匀网格按包围盒投放候选，查询只测落在同一格里的那 1~3 个省。
// 判定本身仍然只走 `pointInProvince`（同一个函数，见它的 cached 参数）——**没有第二套绕数规则**。
//
// ⚠️ 语义必须与 `findProvinceAt` 完全一致（回归里 `test_79` 的「命中自顶向下」守这条）：
//   · **数组靠后的省盖在上面** → 候选按原始下标**降序**逐个测，返回第一个命中的；
//   · 没有有效环的省**整省跳过**（`provinceRings` 为空）；
//   · 洞真的点不中、飞地真的点得中（绕数规则在 `pointInProvince` 里）。
//
// ⚠️ 索引按 `terrain` **数组引用**缓存（见 `createProvinceHitCache`）：本仓每次几何写入都会
//    换新数组（`setTerrain` / `updateProvincesBatch`），所以"引用没变 = 几何没变"成立，
//    不需要任何手工失效点。这与 `coincidentIndexFor` / 骨架索引是同一条纪律。

import { pointInProvince, provinceRings, ringSigns } from './provinceShape';

/** 单省包围盒覆盖超过这么多格 → 进"巨型"表，每查都测（避免一次建索引把格子撑爆） */
const HUGE_CELLS = 1024;
/** 网格总格数上限（防御性：畸形数据下也不会建出百万格） */
const MAX_CELLS = 200000;

const bboxOfPoints = (rings) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (const p of r.points) {
      const x = Number.isFinite(p && p.x) ? p.x : (Array.isArray(p) ? p[0] : NaN);
      const y = Number.isFinite(p && p.y) ? p.y : (Array.isArray(p) ? p[1] : NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
};

/**
 * 给一张省份表建命中索引。
 *
 * @param {Array} terrain 省份数组（顺序 = 绘制顺序，靠后的盖在上面）
 * @param {{targetPerCell?:number}} [opts]
 * @returns {{
 *   terrain:Array, entries:Array, cells:Map<number, number[]>, huge:number[],
 *   grid: {minX:number,minY:number,cell:number,cols:number,rows:number}|null,
 *   stats: {provinces:number, indexed:number, cells:number, buildMs:number}
 * }}
 */
export function buildProvinceHitIndex(terrain, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const list = Array.isArray(terrain) ? terrain : [];
  const entries = [];
  let union = null;

  // ── ① 每个省算一次「环 + 嵌套符号 + 包围盒」────────────────────────────
  for (let i = 0; i < list.length; i++) {
    const prov = list[i];
    const rings = provinceRings(prov);
    if (!rings.length) continue;                       // 与 findProvinceAt 同一条：无环跳过
    const signs = ringSigns(prov);
    const bbox = bboxOfPoints(rings);
    if (!bbox) continue;
    entries.push({ index: i, prov, rings, signs, bbox });
    union = union
      ? {
        minX: Math.min(union.minX, bbox.minX), minY: Math.min(union.minY, bbox.minY),
        maxX: Math.max(union.maxX, bbox.maxX), maxY: Math.max(union.maxY, bbox.maxY),
      }
      : { ...bbox };
  }

  const stats = { provinces: list.length, indexed: entries.length, cells: 0, buildMs: 0 };
  if (!entries.length) {
    stats.buildMs = +((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2);
    return { terrain: list, entries, cells: new Map(), huge: [], grid: null, stats };
  }

  // ── ② 网格：目标每格 ~targetPerCell 个省（按面积摊）─────────────────────
  const targetPerCell = Math.max(1, opts.targetPerCell || 4);
  const spanX = Math.max(union.maxX - union.minX, 1e-6);
  const spanY = Math.max(union.maxY - union.minY, 1e-6);
  let cell = (Number.isFinite(opts.cell) && opts.cell > 0)
    ? opts.cell                                     // 用例/调参可显式指定格边
    : Math.sqrt((spanX * spanY) / Math.max(1, entries.length / targetPerCell));
  cell = Math.max(cell, Math.max(spanX, spanY) / 512, 1e-6);
  let cols = Math.max(1, Math.ceil(spanX / cell));
  let rows = Math.max(1, Math.ceil(spanY / cell));
  while (cols * rows > MAX_CELLS) {                   // 防御：格太密就整格放大
    cell *= 2;
    cols = Math.max(1, Math.ceil(spanX / cell));
    rows = Math.max(1, Math.ceil(spanY / cell));
  }
  const grid = { minX: union.minX, minY: union.minY, cell, cols, rows };
  const cells = new Map();
  const huge = [];

  const put = (key, idx) => {
    const arr = cells.get(key);
    if (arr) arr.push(idx); else cells.set(key, [idx]);
  };

  // ── ③ 按包围盒投放（覆盖到的每一格都放）；太大就进"巨型"表 ──────────────
  for (let e = 0; e < entries.length; e++) {
    const { bbox } = entries[e];
    const c0 = Math.max(0, Math.floor((bbox.minX - grid.minX) / cell));
    const c1 = Math.min(cols - 1, Math.floor((bbox.maxX - grid.minX) / cell));
    const r0 = Math.max(0, Math.floor((bbox.minY - grid.minY) / cell));
    const r1 = Math.min(rows - 1, Math.floor((bbox.maxY - grid.minY) / cell));
    const covered = (c1 - c0 + 1) * (r1 - r0 + 1);
    if (!(covered > 0) || covered > HUGE_CELLS) { huge.push(e); continue; }
    for (let ry = r0; ry <= r1; ry++) {
      for (let cx = c0; cx <= c1; cx++) put(ry * cols + cx, e);
    }
  }

  stats.cells = cells.size;
  stats.buildMs = +((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2);
  return { terrain: list, entries, cells, huge, grid, stats };
}

/**
 * 查一个点命中哪个省 —— **与 `findProvinceAt` 逐字节同义**。
 *
 * @returns {object|null} 命中的省份对象（terrain 里的原引用）；没命中返回 null
 */
export function hitProvince(index, x, y) {
  if (!index || !Number.isFinite(x) || Number.isFinite(y) === false) return null;
  const { entries, grid } = index;
  if (!entries.length) return null;
  if (!grid) return null;
  if (x < grid.minX || y < grid.minY) return null;
  const cx = Math.floor((x - grid.minX) / grid.cell);
  const cy = Math.floor((y - grid.minY) / grid.cell);
  if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return null;

  const inCell = index.cells.get(cy * grid.cols + cx);
  // 候选 = 本格 + 巨型表；按**原始下标降序**（靠后的盖在上面），第一个命中的赢
  const cand = [];
  if (inCell) for (const e of inCell) cand.push(e);
  if (index.huge.length) for (const e of index.huge) cand.push(e);
  // 去重（同一个省可能既在本格又在巨型表？不会；但巨型表可能与本格重叠，防御性去重）
  const picked = cand.length > 1 ? Array.from(new Set(cand)) : cand;
  picked.sort((a, b) => entries[b].index - entries[a].index);

  for (const e of picked) {
    const ent = entries[e];
    const { bbox } = ent;
    if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) continue;
    if (pointInProvince(x, y, ent.prov, ent)) return ent.prov;
  }
  return null;
}

/**
 * 按 `terrain` **引用**缓存的索引句柄（组件侧用这一个，不要自己 new）。
 * 本仓每次几何写入都会换新数组引用 → 引用变 = 几何变 = 重建；
 * 引用没变就直接复用（零失效点）。
 */
export function createProvinceHitCache() {
  let cached = { terrain: null, index: null };
  return {
    /** 取当前 terrain 的索引（必要时重建） */
    get(terrain) {
      if (!Array.isArray(terrain)) return null;
      if (cached.terrain === terrain && cached.index) return cached.index;
      const index = buildProvinceHitIndex(terrain);
      cached = { terrain, index };
      return index;
    },
    /** 当前缓存状态（诊断/用例） */
    stats() {
      return cached.index ? { ...cached.index.stats, cached: true } : { cached: false };
    },
    /** 丢弃缓存（换底图等场景；正常路径靠引用失效，不需要它） */
    clear() { cached = { terrain: null, index: null }; },
  };
}
