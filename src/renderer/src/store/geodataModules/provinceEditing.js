// store/geodataModules/provinceEditing.js — 省份「归属标签网格」store 模块（Phase 3 + P0 第二块）
//
// ctx: { execute, baseMaps, scheduleAutoSaveScenarios, guardWrite, isReadOnly }
//   `baseMaps` 是 scenarioEditing 模块持有的 ref（省份定义表就住在 baseMaps[key].terrain 里）。
//
// ── P0 第二块后的分工（**几何只有一个来源**）─────────────────────────────────
//   · **多边形（`terrain[].points` + `extraRings`）是省份几何的事实源**，画布只渲染它
//     （渲染单一路径 —— 旧的「网格视图」开关已删除，见 ScenarioMap）。
//   · **网格（`provinceLabels`）退为内部中间层**：笔刷/套索/点击填充的输入面，
//     涂抹抬手时把结果**投影回多边形**（`reprojectRings`），随后网格与多边形互相自洽。
//   · 投影只重算**被涂抹到的省份**（`touched`）：没被碰过的省保留导入时的高保真轮廓
//     （把整表按格重采样会把 FMG 的精细边界一次性降级成格点台阶）。
//   · 🔴 网格**唯一性**由「形状签名」保证：`provinceLabels.shape` 存的是各省多边形的
//     指纹（`shapeSignature`）。签名不符 ⇒ 存的网格是别的几何派生出来的，直接按多边形重建。
//     这样就不需要在十几个「改了多边形」的调用点手工作废缓存 —— 漏一个就是静默错数据。
//
// 🔴 **只读态（无项目）下的纪律**：画布编辑入口暂不灰禁，但**绝不能产生意外改动** ——
//   本模块的每个写操作都先过 `guardWrite`，被拒时返回「什么都没发生」（不写 baseMaps、
//   不改内存里的 labels，连懒建网格都只进内存缓存不落 store）。这样「看着能画」也不会
//   留下任何会污染知识库/项目文件的状态。UI 侧另给一句能力说明（见 ScenarioMap）。
//
// 设计要点（为什么这样分）：
//   · **不另建省份定义表**：`labels` 的值 = `terrain[]` 下标 + 1。两套表 = 两套事实源，
//     迟早漂移（本项目已经在「项目文件 / 知识库缓存」上付过一次代价）。
//   · **涂抹期不碰响应式**：一笔拖动有几十次落点、每次改几百格。逐次写响应式对象会拖垮
//     帧预算（铁律 84 同类问题）→ 涂抹期只改模块内缓存的 Uint8Array，抬手时才 diff 成
//     **一条** undo 命令并同步进 store。画布由调用方 `requestRender()` 重绘。
//   · 🔴 **会重编号的操作（删除省份 / 清空归属 / 重建网格）必须记整表快照**：删除时
//     `labels[i] > idx` 的格子会被减 1，动的是「未被删除的格子」，差量记录还原不了。
//   · 重建/懒建网格是**派生数据归一化**，不是用户编辑 → 不进 undo 栈（与 PlanetMap 的
//     `ensureHeightmap` / `initTerrainGrid` 同策略），但改动要落盘。
//   · **分割 / 合并也在这里**（P0 第二块）：它们同时改多边形与网格，必须是一条 undo；
//     几何算法本身在纯函数层 `utils/provinceShape.js`（Node 有单测）。

import {
  gridFromProvinces, rasterizeProvinces, serializeLabels, normalizeStoredGrid,
  stampBrush, lassoCells, renumberAfterDelete, countOwned, usedIndices, cellAt, gridCellCount,
} from '../../utils/provinceGrid';
import {
  shapeSignature, ringsFromLabels, shapePatch, floodRegion, cellsArea,
  normalizeProvince, splitProvinceShape, mergeProvinceShapes, provinceRings,
} from '../../utils/provinceShape';
import { toRaw } from 'vue';

/** 点击填充的规模上限（格）。超过即视为「整块陆地 / 海洋」→ 拒绝，让人改用笔刷。 */
export const MAX_FILL_CELLS = 60000;
/** 点击填充的面积闸门：命中区域超过网格总格数的这个比例 → 拒绝 */
export const FILL_AREA_SHARE = 0.25;

export function createProvinceEditingModule(ctx) {
  const { execute, baseMaps, scheduleAutoSaveScenarios } = ctx;
  const guardWrite = ctx.guardWrite || (() => ({ ok: true }));
  const isReadOnly = ctx.isReadOnly || { value: false };
  const isRO = () => !!(isReadOnly && isReadOnly.value);

  /** 只读态统一拒绝：返回「什么都没发生」的结果 */
  function blocked(action) {
    const gate = guardWrite(action);
    return { blocked: true, readOnly: true, changed: 0, message: gate.error || `${action}被拒绝（只读）` };
  }

  /** 涂抹期活数据（非响应式）：key → { grid, labels, shape } */
  const cache = {};
  /** 当前这一笔：{ key, cells: Map<index, oldValue> } */
  let stroke = null;

  const bm = (key) => (baseMaps.value || {})[key] || null;

  /** 省份定义表（terrain[] = 省份；序号 = 下标 + 1） */
  function provincesOf(key) {
    const m = bm(key);
    return (m && Array.isArray(m.terrain)) ? m.terrain : [];
  }

  /**
   * 去响应式的省份定义表 —— **只用于热循环**（栅格化 / 包围盒推导）。
   *
   * 🔴 为什么必须这么写：栅格化是 O(格数 × 点数) 的双重循环，逐点读 `points[i].x` 时
   *    若对象是 Vue 响应式代理，每次读都要过一层 proxy trap。CDP 实测（6 个省份 / 3600 点
   *    / 3124 格）：走代理 **838.6ms**，同一份数据去代理后只要几十毫秒 ——
   *    真实库 desite 是 21 省 / 25930 点，量级差一个数量级就是「卡死几十秒」。
   *    两层 toRaw：容器与被元素都可能是代理（`{...m, terrain}` 这种展开会把代理原样带走）。
   *    P0 第二块起还要把 `extraRings`（多环）一起剥 —— 只剥主环会让带飞地的省退回代理读取。
   */
  function rawProvinces(key) {
    const list = toRaw(provincesOf(key));
    if (!Array.isArray(list)) return [];
    return list.map((p) => {
      const rp = toRaw(p);
      if (!rp || typeof rp !== 'object') return rp;
      const out = { ...rp };
      const pts = toRaw(rp.points);
      if (Array.isArray(pts)) out.points = toRaw(pts).map((q) => (q && typeof q === 'object') ? toRaw(q) : q);
      const extra = toRaw(rp.extraRings);
      if (Array.isArray(extra)) {
        out.extraRings = extra.map((r) => {
          const rr = toRaw(r);
          if (!rr || typeof rr !== 'object') return rr;
          const epts = toRaw(rr.points);
          return Array.isArray(epts)
            ? { ...rr, points: toRaw(epts).map((q) => (q && typeof q === 'object') ? toRaw(q) : q) }
            : rr;
        });
      }
      return out;
    });
  }

  // ── 形状签名：网格「是不是这套多边形派生的」的唯一判据 ────────────────────
  //    WeakMap 按 terrain 数组记忆化：本模块与 scenarioEditing 的每次写入都**整体替换**数组
  //    （`{...m, terrain: next}`）→ 换数组即换签名，天然失效，且零额外开销。
  const sigCache = new WeakMap();
  function terrainShape(key) {
    const terrain = bm(key)?.terrain;
    if (!Array.isArray(terrain)) return 0;
    let s = sigCache.get(terrain);
    if (s === undefined) {
      s = shapeSignature(rawProvinces(key));
      sigCache.set(terrain, s);
    }
    return s;
  }

  /** 让缓存条目的签名跟上当前 terrain（每次写 terrain / labels 后都要调，见文件头说明） */
  function stampShape(key) {
    const entry = cache[key];
    if (entry) entry.shape = terrainShape(key);
    return entry;
  }

  /** 把 labels 写回 store（整体替换对象 → 保证响应式；并调度落盘） */
  function commit(key, { save = true } = {}) {
    const entry = cache[key];
    const m = bm(key);
    // 只读态下绝不写 store（防御：即便调用方漏了 guardWrite，也不产生状态改动）
    if (isRO()) return;
    if (!entry || !m) return;
    const shape = terrainShape(key);
    entry.shape = shape;
    baseMaps.value = {
      ...baseMaps.value,
      [key]: {
        ...m,
        provinceLabels: {
          cols: entry.grid.cols, rows: entry.grid.rows, cell: entry.grid.cell,
          ox: entry.grid.ox, oy: entry.grid.oy,
          shape,
          data: serializeLabels(entry.labels),
        },
        updatedAt: new Date().toISOString(),
      },
    };
    if (save) scheduleAutoSaveScenarios();
  }

  /** 作废网格缓存（几何被外部改过时由签名检查自动完成，这里给显式入口） */
  function invalidateProvinceGrid(key) {
    delete cache[key];
  }

  /**
   * 懒建 + 自愈：已有合法网格**且与当前多边形同源**（shape 相符）就用它；
   * 否则按省份多边形栅格化一副新的并落盘。
   */
  function ensureProvinceGrid(key) {
    const shape = terrainShape(key);
    const hit = cache[key];
    if (hit && hit.shape === shape) return hit;
    const m = bm(key);
    if (!m) return null;
    const provinces = provincesOf(key);
    const stored = normalizeStoredGrid(m.provinceLabels, provinces);
    // 签名一致 → 直接用；**签名缺失（旧版数据 / 旧字段）→ 一次性信任并盖章**：
    // 宁可少一次自愈，也绝不把用户在旧版里画好的归属当场丢掉（本仓第一原则：破坏性更新
    // 只许破坏代码、不许破坏用户数据）。盖过章之后，后续一律由指纹严格管辖。
    const storedShape = m.provinceLabels ? m.provinceLabels.shape : undefined;
    if (stored && (storedShape === undefined || storedShape === shape)) {
      cache[key] = { grid: stored.grid, labels: stored.labels, shape };
      return cache[key];
    }
    const raw = rawProvinces(key);              // 热循环必须去响应式（见 rawProvinces 注释）
    const grid = gridFromProvinces(raw);
    const labels = rasterizeProvinces(raw, grid);   // 已收口到 provinceShape（多环 / 带洞口径）
    cache[key] = { grid, labels, shape };
    commit(key);          // 只读态下 commit 直接返回 → 网格只在内存里（只读 ≠ 看不了）
    return cache[key];
  }

  /** 供渲染读取（活数据引用，不要改它）。几何被外部改过（签名不符）→ 返回 null，等重建。 */
  function getProvinceGrid(key) {
    const entry = cache[key];
    if (!entry) return null;
    if (entry.shape !== terrainShape(key)) return null;
    return entry;
  }

  /**
   * 按省份多边形重新栅格化（导入底图 / 手工改了多边形之后调）
   */
  function rebuildProvinceGrid(key) {
    if (isRO()) return blocked('重建省份网格');
    if (!bm(key)) return null;
    const before = cache[key]
      ? { grid: cache[key].grid, labels: new Uint8Array(cache[key].labels), shape: cache[key].shape }
      : null;
    const raw = rawProvinces(key);              // 热循环必须去响应式（见 rawProvinces 注释）
    const grid = gridFromProvinces(raw);
    const labels = rasterizeProvinces(raw, grid);
    const shape = terrainShape(key);
    cache[key] = { grid, labels, shape };
    execute({
      type: 'province-grid-rebuild',
      label: '重建省份网格',
      undo: () => {
        if (before) cache[key] = { ...before, labels: new Uint8Array(before.labels) };
        else delete cache[key];
        commit(key);
      },
      redo: () => {
        cache[key] = { grid, labels: new Uint8Array(labels), shape };
        commit(key);
      },
    });
    return { grid, owned: countOwned(labels) };
  }

  // ============================================================
  // 网格 → 多边形（写回）：渲染的唯一来源是多边形
  // ============================================================

  /**
   * 用当前网格重算「被碰到的省份」的多边形，返回新的 terrain 数组（无改动给 null）。
   * @param {Set<number>|null} touched 1-based 省份序号；null = 全部
   */
  function reprojectRings(key, entry, touched) {
    if (!entry) return null;
    if (touched && !touched.size) return null;
    const byLabel = ringsFromLabels(entry.labels, entry.grid);
    const terrain = provincesOf(key);
    let changed = false;
    const next = terrain.map((p, i) => {
      const idx = i + 1;
      if (touched && !touched.has(idx)) return p;
      const loops = byLabel.get(idx) || [];
      const kind = p.kind === 'sea' ? 'sea' : 'land';
      // 🔴 `fromGrid: true`：这些环是从归属格轮廓提取的（带格点台阶），渲染端据此做 Chaikin
      //    平滑；不标记 → 画布上就是「马赛克台阶边」（用户投诉「丑东西」的几何来源）。
      const patch = loops.length
        ? shapePatch(loops.map((pts) => ({ points: pts, kind, fromGrid: true })))
        : { points: [], extraRings: undefined, fromGrid: false };
      changed = true;
      return normalizeProvince({ ...p, ...patch });
    });
    return changed ? next : null;
  }

  /** 写 terrain（新数组 → 响应式）+ 同步签名 */
  function setTerrain(key, terrain, { save = true } = {}) {
    const m = bm(key);
    if (!m) return;
    baseMaps.value = { ...baseMaps.value, [key]: { ...m, terrain, updatedAt: new Date().toISOString() } };
    // 序号语义变了（长度可能变短）→ 越界标签置无主，别让取色函数越界
    const entry = cache[key];
    if (entry) {
      const maxIdx = terrain.length;
      let fixed = false;
      for (let i = 0; i < entry.labels.length; i++) {
        if (entry.labels[i] > maxIdx) { entry.labels[i] = 0; fixed = true; }
      }
      stampShape(key);
      if (fixed) commit(key, { save: false });
    }
    if (save) scheduleAutoSaveScenarios();
  }

  // ============================================================
  // 笔刷 / 套索（一笔 = 一条 undo，含多边形写回）
  // ============================================================

  function beginProvinceStroke() {
    stroke = { key: null, cells: new Map() };
  }

  /** 一次落点（内部按格 dab）；涂抹期调用，不压栈 */
  function applyProvinceStroke(key, { x, y, radius = 4, strength = 0.8, tool = 'paint', target = 0 } = {}) {
    if (isRO()) { blocked('省份笔刷划归'); return 0; }   // 只读：连内存里的格都不动
    const entry = ensureProvinceGrid(key);
    if (!entry) return 0;
    // 划归必须有目标省份（还没有省份时先「新建省份」）—— 否则会写出指向不存在省份的标签
    if (tool === 'paint' && (target < 1 || target > provincesOf(key).length)) return 0;
    if (!stroke || stroke.key !== key) stroke = { key, cells: new Map() };
    const { c, r } = cellAt(entry.grid, x, y);
    const changed = stampBrush(entry.labels, entry.grid, { c, r, radius, strength, tool, target });
    for (const [i, old] of changed) if (!stroke.cells.has(i)) stroke.cells.set(i, old);
    return changed.length;
  }

  /**
   * 抬手：把整笔压成一条 undo（**labels 差量 + 被碰省份的多边形写回**）。
   * `cells` 里存的是**整笔开始前**的旧值（`Map` 首见即记），redo 时写入抬手瞬间的新值。
   * 🔴 labels 必须**就地修改**（同一个 Uint8Array 引用）：外部（画布/用例）持有的是这个引用，
   *    换新数组会让它们读到旧数据（本项目已踩过「重建对象导致引用脱钩」的坑，见 AGENTS.md）。
   * @returns {{ changed:number, label:string, reprojected:number }|null}
   */
  function endProvinceStroke(label = '省份笔刷') {
    const s = stroke;
    stroke = null;
    if (!s || !s.cells.size) return null;
    const key = s.key;
    const entry = cache[key];
    if (!entry) return null;
    const labels = entry.labels;
    const entries = [...s.cells.entries()].map(([i, old]) => [i, old, labels[i]]);
    const touched = new Set();
    for (const [, old, now] of entries) { if (old) touched.add(old); if (now) touched.add(now); }
    const beforeTerrain = provincesOf(key);
    const nextTerrain = reprojectRings(key, entry, touched) || beforeTerrain;
    const reprojected = nextTerrain === beforeTerrain ? 0 : touched.size;

    const apply = (idx, terrain) => {
      for (const e of entries) labels[e[0]] = e[idx];
      setTerrain(key, terrain, { save: false });
      commit(key);
    };
    execute({
      type: 'province-brush',
      label,
      undo: () => apply(1, beforeTerrain),
      redo: () => apply(2, nextTerrain),
    });
    return { changed: entries.length, label, reprojected };
  }

  /** 自由轮廓：一笔整批划归（同样写回多边形） */
  function applyProvinceLasso(key, worldPoly, target, label = '自由轮廓划归') {
    if (isRO()) return blocked('自由轮廓划归');
    const entry = ensureProvinceGrid(key);
    if (!entry) return null;
    const changed = lassoCells(entry.labels, entry.grid, worldPoly, target);
    if (!changed.length) return { changed: 0, label, reprojected: 0 };
    const labels = entry.labels;
    const entries = changed.map(([i, old]) => [i, old, labels[i]]);
    const touched = new Set();
    for (const [, old, now] of entries) { if (old) touched.add(old); if (now) touched.add(now); }
    const beforeTerrain = provincesOf(key);
    const nextTerrain = reprojectRings(key, entry, touched) || beforeTerrain;

    const apply = (idx, terrain) => {
      for (const e of entries) labels[e[0]] = e[idx];
      setTerrain(key, terrain, { save: false });
      commit(key);
    };
    execute({
      type: 'province-lasso',
      label,
      undo: () => apply(1, beforeTerrain),
      redo: () => apply(2, nextTerrain),
    });
    return { changed: entries.length, label, reprojected: nextTerrain === beforeTerrain ? 0 : touched.size };
  }

  /**
   * 点击填充（**面积闸门**）：把点击处**所在的封闭连通区域**整块划归目标省份。
   *
   * 为什么必须有闸门：点一下就把「整片海 / 整块大陆」填成某省是这类工具最经典的灾难
   * （用户点歪一格 → 全图变色，undo 都不知道该恢复到哪一步）。闸门两条：
   *   ① 命中区域超过网格总面积的 `FILL_AREA_SHARE` → 拒绝（点名占比 + 建议用笔刷分次涂）；
   *   ② 泛滥格数超过 `MAX_FILL_CELLS` → 直接不返回（视为不当使用）。
   * @returns {{ changed:number, label:string, rejected?:string, message?:string }}
   */
  function fillProvinceRegion(key, { x, y }, target, opts = {}) {
    if (isRO()) return blocked('点击填充');
    const maxShare = opts.maxShare ?? FILL_AREA_SHARE;
    const entry = ensureProvinceGrid(key);
    if (!entry) return { changed: 0, rejected: 'no-grid', message: '底图没有可用的省份网格' };
    const provs = provincesOf(key);
    if (!(target >= 1 && target <= provs.length)) {
      return { changed: 0, rejected: 'no-target', message: '请先在上方选择要填充到的省份' };
    }
    const { c, r } = cellAt(entry.grid, x, y);
    const cells = floodRegion(entry.labels, entry.grid, c, r, { cap: Math.min(MAX_FILL_CELLS, gridCellCount(entry.grid)) });
    if (!cells.length) {
      const cap = Math.min(MAX_FILL_CELLS, gridCellCount(entry.grid));
      return {
        changed: 0, rejected: 'too-big',
        message: `这里连成一片的区域超过 ${cap} 格（多半是整块陆地或海洋）——请改用笔刷分次涂抹`,
      };
    }
    const total = gridCellCount(entry.grid);
    const share = cells.length / total;
    if (share > maxShare) {
      return {
        changed: 0, rejected: 'area-gate',
        message: `这个区域占全图 ${Math.round(share * 100)}%（超过 ${Math.round(maxShare * 100)}%）——`
          + '多半是整块陆地或海洋，请改用笔刷分次涂抹',
      };
    }
    const labels = entry.labels;
    const entries = [];
    for (const i of cells) if (labels[i] !== target) entries.push([i, labels[i]]);
    if (!entries.length) return { changed: 0, message: '这一块已经属于该省份' };
    // 目标省 + 被覆盖掉的原归属省都要写回多边形（它们的地盘变了）
    const touched = new Set([target]);
    for (const e of entries) if (e[1]) touched.add(e[1]);
    const beforeTerrain = provincesOf(key);
    const nextTerrain = reprojectRings(key, entry, touched) || beforeTerrain;
    for (const e of entries) labels[e[0]] = target;

    const apply = (idx, terrain) => {
      for (let k = 0; k < entries.length; k++) labels[entries[k][0]] = idx ? target : entries[k][1];
      setTerrain(key, terrain, { save: false });
      commit(key);
    };
    execute({
      type: 'province-fill',
      label: `点击填充 ${cells.length} 格`,
      undo: () => apply(0, beforeTerrain),
      redo: () => apply(1, nextTerrain),
    });
    return { changed: entries.length, cells: cells.length, area: cellsArea(cells, entry.grid), label: `点击填充 ${cells.length} 格` };
  }

  // ============================================================
  // 分割 / 合并（几何在纯函数层；这里只管「一条 undo + 网格作废」）
  // ============================================================

  /**
   * 沿切割线把省份一分为二（**保留多环与 land/sea**）。
   * 原省占原位（序号不变 → 标签继续有效），新省追加到表尾（新序号原本无主）。
   * 网格按新多边形重建（几何变化很大，增量改格没有意义）。
   */
  function splitProvince(key, provinceId, p1, p2) {
    if (isRO()) return blocked('分割省份');
    const terrain = provincesOf(key);
    const idx = terrain.findIndex((p) => p.id === provinceId);
    if (idx < 0) return null;
    const res = splitProvinceShape(terrain[idx], p1, p2, { makeId: (s) => `prov_${Date.now()}_${s}` });
    if (!res) return { rejected: 'no-cut', message: '切割线没有穿过这个省份（两点要落在它的两侧）' };

    const before = terrain;
    const after = terrain.map((p, i) => (i === idx ? res.a : p)).concat([res.b]);
    const apply = (next) => {
      invalidateProvinceGrid(key);          // 几何换了 → 网格按新多边形重建（签名检查也会兜住）
      setTerrain(key, next, { save: false });
      scheduleAutoSaveScenarios();
    };
    execute({
      type: 'province-split',
      label: `分割省份「${terrain[idx].name || provinceId}」`,
      undo: () => apply(before),
      redo: () => apply(after),
    });
    return { a: res.a, b: res.b, index: idx + 1, newIndex: after.length };
  }

  /**
   * 合并若干省份为一个**多环实体**（共边抵销的精确并集，取代旧的凸包合并）。
   * 结果替换第一个省份的位置（其余删除）→ 表变短 ⇒ 之后的序号整体减，标签必须重编号，
   * 所以合并后网格整体重建（与删除省份同样记整表快照的语义，但重建更直接）。
   */
  function mergeProvinces(key, provinceIds, { name = '' } = {}) {
    if (isRO()) return blocked('合并省份');
    const ids = (provinceIds || []).filter(Boolean);
    if (ids.length < 2) return { rejected: 'too-few', message: '至少选择两个省份才能合并' };
    const terrain = provincesOf(key);
    const picked = terrain.filter((p) => ids.includes(p.id));
    if (picked.length < 2) return { rejected: 'not-found', message: '要合并的省份已不存在' };
    const merged = mergeProvinceShapes(picked);
    if (!merged) return { rejected: 'no-geometry', message: '这些省份还没有几何（先涂抹出轮廓再合并）' };

    const keepId = picked[0].id;
    const mergedProv = normalizeProvince({
      ...picked[0],
      id: keepId,
      name: name || picked.map((p) => p.name).filter(Boolean).join('+') || '合并省份',
      kind: merged.shape.kind || picked[0].kind || 'land',
      ...shapePatch((merged.shape.extraRings || []).length
        ? [{ points: merged.shape.points, kind: merged.shape.kind || 'land' },
           ...merged.shape.extraRings]
        : [{ points: merged.shape.points, kind: merged.shape.kind || 'land' }]),
    });
    const before = terrain;
    const after = terrain
      .map((p) => (p.id === keepId ? mergedProv : p))
      .filter((p) => !(ids.includes(p.id) && p.id !== keepId));

    const apply = (next) => {
      invalidateProvinceGrid(key);
      setTerrain(key, next, { save: false });
      scheduleAutoSaveScenarios();
    };
    execute({
      type: 'province-merge',
      label: `合并 ${picked.length} 个省份`,
      undo: () => apply(before),
      redo: () => apply(after),
    });
    return {
      merged: mergedProv, removed: picked.length - 1,
      method: merged.method, loops: merged.loops,
      area: merged.shape.points.length,
    };
  }

  // ============================================================
  // 省份定义表（新增 / 删除 / 清空）—— 与 terrain[] 同步
  // ============================================================

  /** 建一个「纯网格省份」（没有多边形轮廓：边界由 labels 自动提取）并返回它的序号 */
  function addBrushProvince(key, { name = '', color = '' } = {}) {
    if (isRO()) return blocked('新建省份');
    const m = bm(key);
    if (!m) return null;
    const provinces = [...provincesOf(key)];
    const idx = provinces.length + 1;
    const province = normalizeProvince({
      id: `prov_grid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name || `省份 ${idx}`,
      points: [],                 // 涂出来的省份没有轮廓 —— 边界由 labels 提取（抬手时写回）
      kind: 'land',
      color: color || '#8b7355',
      biome: '', culture: '', coast: false,
      fromGrid: true,
    });
    const before = provinces;
    const after = [...provinces, province];
    execute({
      type: 'add-brush-province',
      label: '新建省份',
      undo: () => { setTerrain(key, before); },
      redo: () => { setTerrain(key, after); },
    });
    return { idx, id: province.id, name: province.name };
  }

  /**
   * 删除省份（**重编号安全**）：labels 里所有 > idx 的序号减 1，并把 terrain 数组同步缩短。
   * 🔴 整表快照：重编号改动的是「别的省份的格子」，差量还原不了。
   */
  function removeProvinceWithGrid(key, provinceId) {
    if (isRO()) return blocked('删除省份');
    const provinces = provincesOf(key);
    const idx = provinces.findIndex(p => p.id === provinceId);
    if (idx < 0) return null;
    const entry = ensureProvinceGrid(key);
    const before = { terrain: provinces.map(p => ({ ...p })), labels: entry ? new Uint8Array(entry.labels) : null };
    const afterTerrain = provinces.filter((_, i) => i !== idx);
    const afterLabels = entry ? new Uint8Array(entry.labels) : null;
    let cleared = 0;
    if (afterLabels) cleared = renumberAfterDelete(afterLabels, idx + 1).cleared;

    const apply = (terrain, labels) => {
      if (entry && labels) { entry.labels.set(labels); }
      setTerrain(key, terrain, { save: false });       // 内部会 stampShape
      if (entry && labels) commit(key, { save: false });
      scheduleAutoSaveScenarios();
    };
    execute({
      type: 'remove-province-grid',
      label: `删除省份「${provinces[idx].name || provinceId}」`,
      undo: () => apply(before.terrain, before.labels),
      redo: () => apply(afterTerrain, afterLabels),
    });
    return { removed: provinces[idx].name || provinceId, cleared, ownedAfter: afterLabels ? countOwned(afterLabels) : 0 };
  }

  /** 清空归属（所有格 → 无主），省份定义表保留 —— 演示「海陆从 FMG 来、省份由司天切」 */
  function clearProvinceLabels(key) {
    if (isRO()) return blocked('清空省份归属');
    const entry = ensureProvinceGrid(key);
    if (!entry) return null;
    const before = new Uint8Array(entry.labels);
    const after = new Uint8Array(entry.labels.length);
    const apply = (snap) => { entry.labels.set(snap); commit(key); };
    execute({
      type: 'clear-province-labels',
      label: '清空省份归属',
      undo: () => apply(before),
      redo: () => apply(after),
    });
    return { cells: before.length, cleared: countOwned(before) };
  }

  /** 统计（状态栏/用例用） */
  function provinceGridStats(key) {
    const entry = ensureProvinceGrid(key);
    if (!entry) return null;
    return {
      cols: entry.grid.cols, rows: entry.grid.rows, cell: entry.grid.cell,
      total: gridCellCount(entry.grid), owned: countOwned(entry.labels),
      used: usedIndices(entry.labels), provinces: provincesOf(key).length,
      borders: 0,
    };
  }

  /** 供诊断/用例：某省份的环数（多环 = 飞地 / 洞） */
  function provinceRingStats(key, provinceId) {
    const p = provincesOf(key).find(q => q.id === provinceId);
    if (!p) return null;
    return { rings: provinceRings(p).length, kind: p.kind || 'land' };
  }

  return {
    ensureProvinceGrid, getProvinceGrid, rebuildProvinceGrid, invalidateProvinceGrid,
    beginProvinceStroke, applyProvinceStroke, endProvinceStroke, applyProvinceLasso,
    fillProvinceRegion, splitProvince, mergeProvinces,
    addBrushProvince, removeProvinceWithGrid, clearProvinceLabels,
    provinceGridStats, provinceRingStats,
  };
}
