// store/geodataModules/provinceEditing.js — 省份「归属标签网格」store 模块（Phase 3）
//
// ctx: { execute, baseMaps, scheduleAutoSaveScenarios, guardWrite, isReadOnly }
//   `baseMaps` 是 scenarioEditing 模块持有的 ref（省份定义表就住在 baseMaps[key].terrain 里）。
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

import {
  gridFromProvinces, rasterizeProvinces, serializeLabels, normalizeStoredGrid,
  stampBrush, lassoCells, renumberAfterDelete, countOwned, usedIndices, cellAt, gridCellCount,
} from '../../utils/provinceGrid';

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

  /** 涂抹期活数据（非响应式）：key → { grid, labels } */
  const cache = {};
  /** 当前这一笔：{ key, cells: Map<index, oldValue> } */
  let stroke = null;

  const bm = (key) => (baseMaps.value || {})[key] || null;

  /** 省份定义表（terrain[] = 省份；序号 = 下标 + 1） */
  function provincesOf(key) {
    const m = bm(key);
    return (m && Array.isArray(m.terrain)) ? m.terrain : [];
  }

  /** 把 labels 写回 store（整体替换对象 → 保证响应式；并调度落盘） */
  function commit(key, { save = true } = {}) {
    const entry = cache[key];
    const m = bm(key);
    // 只读态下绝不写 store（防御：即便调用方漏了 guardWrite，也不产生状态改动）
    if (isRO()) return;
    if (!entry || !m) return;
    baseMaps.value = {
      ...baseMaps.value,
      [key]: {
        ...m,
        provinceLabels: {
          cols: entry.grid.cols, rows: entry.grid.rows, cell: entry.grid.cell,
          ox: entry.grid.ox, oy: entry.grid.oy,
          data: serializeLabels(entry.labels),
        },
        updatedAt: new Date().toISOString(),
      },
    };
    if (save) scheduleAutoSaveScenarios();
  }

  /** 懒建 + 自愈：已有合法网格就用它；否则按省份多边形栅格化一副新的并落盘 */
  function ensureProvinceGrid(key) {
    if (cache[key]) return cache[key];
    const m = bm(key);
    if (!m) return null;
    const provinces = provincesOf(key);
    const stored = normalizeStoredGrid(m.provinceLabels, provinces);
    if (stored) {
      cache[key] = stored;
      return cache[key];
    }
    const grid = gridFromProvinces(provinces);
    const labels = rasterizeProvinces(provinces, grid);
    cache[key] = { grid, labels };
    commit(key);          // 只读态下 commit 直接返回 → 网格只在内存里（只读 ≠ 看不了）
    return cache[key];
  }

  /** 供渲染读取（活数据引用，不要改它） */
  function getProvinceGrid(key) {
    return cache[key] || null;
  }

  /** 按省份多边形重新栅格化（导入底图 / 手工改了多边形之后调） */
  function rebuildProvinceGrid(key) {
    if (isRO()) return blocked('重建省份网格');
    const provinces = provincesOf(key);
    if (!bm(key)) return null;
    const before = cache[key] ? { grid: cache[key].grid, labels: new Uint8Array(cache[key].labels) } : null;
    const grid = gridFromProvinces(provinces);
    const labels = rasterizeProvinces(provinces, grid);
    cache[key] = { grid, labels };
    execute({
      type: 'province-grid-rebuild',
      label: '重建省份网格',
      undo: () => {
        if (before) cache[key] = { grid: before.grid, labels: new Uint8Array(before.labels) };
        else delete cache[key];
        commit(key);
      },
      redo: () => {
        cache[key] = { grid, labels: new Uint8Array(labels) };
        commit(key);
      },
    });
    return { grid, owned: countOwned(labels) };
  }

  // ============================================================
  // 笔刷 / 套索（一笔 = 一条 undo）
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
   * 抬手：把整笔压成一条 undo。
   * `cells` 里存的是**整笔开始前**的旧值（`Map` 首见即记），redo 时写入抬手瞬间的新值。
   * @returns {{ changed:number, label:string }|null}
   */
  function endProvinceStroke(label = '省份笔刷') {
    const s = stroke;
    stroke = null;
    if (!s || !s.cells.size) return null;
    const entry = cache[s.key];
    if (!entry) return null;
    const labels = entry.labels;
    const entries = [...s.cells.entries()].map(([i, old]) => [i, old, labels[i]]);
    const apply = (idx) => {
      for (const e of entries) labels[e[0]] = e[idx];
      commit(s.key);
    };
    execute({ type: 'province-brush', label, undo: () => apply(1), redo: () => apply(2) });
    return { changed: entries.length, label };
  }

  /** 自由轮廓：一笔整批划归 */
  function applyProvinceLasso(key, worldPoly, target, label = '自由轮廓划归') {
    if (isRO()) return blocked('自由轮廓划归');
    const entry = ensureProvinceGrid(key);
    if (!entry) return null;
    const changed = lassoCells(entry.labels, entry.grid, worldPoly, target);
    if (!changed.length) return { changed: 0, label };
    const labels = entry.labels;
    const entries = changed.map(([i, old]) => [i, old, labels[i]]);
    const apply = (idx) => {
      for (const e of entries) labels[e[0]] = e[idx];
      commit(key);
    };
    execute({ type: 'province-lasso', label, undo: () => apply(1), redo: () => apply(2) });
    return { changed: entries.length, label };
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
    const province = {
      id: `prov_grid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name || `省份 ${idx}`,
      points: [],                 // 涂出来的省份没有轮廓 —— 边界由 labels 提取
      color: color || '#8b7355',
      biome: '', culture: '', coast: false,
      fromGrid: true,
    };
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

  function setTerrain(key, terrain) {
    const m = bm(key);
    if (!m) return;
    baseMaps.value = { ...baseMaps.value, [key]: { ...m, terrain, updatedAt: new Date().toISOString() } };
    // 序号语义变了（长度可能变短）→ 越界标签置无主，别让取色函数越界
    const entry = cache[key];
    if (entry) {
      const maxIdx = terrain.length;
      let fixed = false;
      for (let i = 0; i < entry.labels.length; i++) if (entry.labels[i] > maxIdx) { entry.labels[i] = 0; fixed = true; }
      if (fixed) commit(key, { save: false });
    }
    scheduleAutoSaveScenarios();
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
      const m = bm(key);
      if (!m) return;
      baseMaps.value = { ...baseMaps.value, [key]: { ...m, terrain, updatedAt: new Date().toISOString() } };
      if (entry && labels) { entry.labels.set(labels); commit(key, { save: false }); }
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

  return {
    ensureProvinceGrid, getProvinceGrid, rebuildProvinceGrid,
    beginProvinceStroke, applyProvinceStroke, endProvinceStroke, applyProvinceLasso,
    addBrushProvince, removeProvinceWithGrid, clearProvinceLabels, provinceGridStats,
  };
}
