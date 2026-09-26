// utils/heightmapAccess.js — 「一张底图到底该用哪份高度图」的唯一判定（A1/M1，2026-09-24）
//
// ── 要解决的问题 ─────────────────────────────────────────────────────────────
// 剧本底图（`baseMaps[key]`）与行星（`mapData[planetId]`）**各持一份高度图**，互不相通：
// 在剧本底图涂的山，行星地图看不见；在行星涂的高度，回剧本又没了。
//
// ── 决策（见 docs/A1_DATA_MODEL_DECISION.md）─────────────────────────────────
// **以行星的高度图为单一真源，剧本底图按 `planetId` 绑定"代理"过去 —— 不复制。**
//   · 绑定了  → 读 **与** 写都落在行星那份上（本文件 + store 的 `commitHeightmap` 共同保证）
//   · 没绑定  → 用底图自己那份，行为与从前**完全一致**（自建底图 / 旧项目 → 向后兼容）
//
// ── 为什么必须读写一起切 ─────────────────────────────────────────────────────
// 剧本侧原来的写入模式是「整体替换 baseMap 对象」：
//     `baseMaps.value = { ...baseMaps.value, [key]: { ...baseMap, heightmap: { ...hm, h } } }`
// 这种写法**天然与"共享引用"冲突**（一写就把引用换掉了）。所以只把「读」切到访问器、
// 而「写」还写回底图自己，会得到「读行星 / 写自己」—— 比不改更糟。
// 结论：**同一处代码的读与写必须一起走本模块的解析 + store 的 commit**。
//
// ── 本文件只放纯函数（不碰 store / 不碰 Vue）──────────────────────────────────
// 便于 Node 单测（scripts/tests/unit/test_heightmap_access.js）。

// ── 绑定字段 ────────────────────────────────────────────────────────────────
/** 底图上的绑定字段名（指向行星 id） */
export const BASEMAP_PLANET_KEY = 'planetId';

/** 取底图绑定到的行星 id；没绑定/非法则返回 null */
export function boundPlanetId(baseMap) {
  const id = baseMap && baseMap[BASEMAP_PLANET_KEY];
  return (typeof id === 'string' && id) ? id : null;
}

/**
 * 解析该底图**实际应该使用**的高度图。
 *
 * ⚠️ 绑定即**只认行星**：行星还没有高度图时返回 `null`（由调用方在**行星侧**创建），
 *    绝不悄悄回落到底图自己那份 —— 那正是"双源漂移"的起点。
 *
 * @param {object|null} baseMap 底图对象（`baseMaps[key]`）
 * @param {object|null} mapDataById 行星地图字典（`mapData`，键为 planetId）
 * @returns {{ heightmap: object|null, owner: 'planet'|'self', planetId: string|null }}
 */
export function resolveHeightmap(baseMap, mapDataById) {
  const pid = boundPlanetId(baseMap);
  if (pid) {
    const planet = mapDataById && mapDataById[pid];
    if (!planet) {
      // 🔴 **悬空绑定**（行星已被删除 / 改名 / 从未建立地图数据）：
      //    绝不能静默返回 null —— 那会让底图的高度图凭空消失，用户只看到「地图怎么空了」。
      //    改为**回落到自身**（若还留着）并回报 `dangling`，由调用方提示「此底图绑定的行星已不存在」，
      //    引导用户解绑或重新绑定。
      //    ⚠️ 与下面的「行星存在但还没高度图」严格区分：那种情况是**正常**的"还没创建"，
      //       必须返回 planet/null（不能回落到 self —— 那正是双源漂移的起点）。
      return {
        heightmap: (baseMap && baseMap.heightmap) || null,
        owner: 'self',
        planetId: pid,
        dangling: true,
      };
    }
    return { heightmap: planet.heightmap || null, owner: 'planet', planetId: pid, dangling: false };
  }
  return { heightmap: (baseMap && baseMap.heightmap) || null, owner: 'self', planetId: null, dangling: false };
}

/**
 * 高度图是否可以安全地开始编辑（有网格点）。
 * 与 `resolveHeightmap` 配套使用，避免每个调用点各写一遍同样的三层判空。
 */
export function hasGrid(heightmap) {
  return !!(heightmap && heightmap.grid && Array.isArray(heightmap.grid.points) && heightmap.grid.points.length > 0);
}

/**
 * 规划「把底图绑定到行星」这一步要做的改动 —— **纯函数，只返回计划，不改数据**。
 *
 * 迁移规则（一次性）：
 *   · 底图有自己的高度图、行星没有 → 把**底图那份搬到行星**（`migrate` 字段），底图侧不再保留。
 *   · 两边都有 → **拒绝**并回报冲突（绝不静默选一边丢掉另一边 —— 那可能是用户几小时的手工地形）。
 *   · 只有行星有 → 直接绑定。
 *   · 都没有 → 直接绑定（行星侧之后懒创建）。
 *
 * @returns {{
 *   ok: true, nextBaseMap: object, migrate?: { planetId: string, heightmap: object }
 * } | {
 *   ok: false, error: string, conflict?: boolean,
 *   selfHeightmap?: object, planetHeightmap?: object
 * }}
 */
export function planBindBaseMapToPlanet(baseMap, planetId, mapDataById, allBaseMaps) {
  if (!baseMap) return { ok: false, error: '底图不存在' };
  if (!planetId) return { ok: false, error: '没有指定要绑定的行星' };
  const planet = mapDataById && mapDataById[planetId];
  if (!planet) return { ok: false, error: `行星「${planetId}」还没有地图数据，请先进入该行星地图` };

  // ★ R2（2026-09-25）：**一星一图** —— 同一颗行星的高度图不能被两张底图同时绑定。
  //   否则两张「历史时期」地图会共用一份地形：在时期 A 涂的山会立刻出现在时期 B 上，
  //   而用户以为每张地图各有自己的地形。这类串味**不会报错**，往往几周后才被发现。
  //   只有调用方传了 `allBaseMaps`（整个 baseMaps 对象）才检查；用**引用比较**排除自身
  //   —— 底图的键既可能是行星名也可能是 id（见 store/geodata.js 的 idRefDicts 注释），不可靠。
  if (allBaseMaps && typeof allBaseMaps === 'object') {
    for (const [k, v] of Object.entries(allBaseMaps)) {
      if (!v || v === baseMap) continue;
      if (boundPlanetId(v) !== planetId) continue;
      const holder = v.name || v.id || k;
      return {
        ok: false,
        conflict: true,
        conflictKind: 'planet-taken',
        error: `行星「${planetId}」已被底图「${holder}」绑定 —— 一份地形不能同时服务两张地图`
             + `（否则两张图会共享地形）。请先解绑「${holder}」`,
        holderKey: k,
        holderName: holder,
        planetId,
      };
    }
  }

  const selfHm = baseMap.heightmap;
  const planetHm = planet.heightmap;

  if (selfHm && planetHm) {
    return {
      ok: false,
      conflict: true,
      error: '底图与行星**都已有高度图**：绑定会丢掉其中一份。请先决定保留哪边（可先清空一边再绑定）',
      selfHeightmap: selfHm,
      planetHeightmap: planetHm,
    };
  }

  const nextBaseMap = { ...baseMap, [BASEMAP_PLANET_KEY]: planetId };
  delete nextBaseMap.heightmap;   // 绑定期起，高度图只存在于行星侧（本对象上是副本，delete 不影响入参）
  if (selfHm && !planetHm) {
    return { ok: true, nextBaseMap, migrate: { planetId, heightmap: selfHm } };
  }
  return { ok: true, nextBaseMap };
}

/** 默认格子间距（与行星侧 `DEFAULT_SPACING` 保持一致的口径） */
export const DEFAULT_GRID_SPACING = 14.4;

/**
 * 由地形多边形的包围盒推出一套栅格（原点对齐、行列取整）—— 供**未绑定底图**创建高度图用。
 *
 * 为什么需要它：底图的高度图此前**只有 `.map` 导入一条来源**，用户新建一张底图后
 * 高度/群系/文化笔刷与一键派生全都因为「没有 heightmap」而直接 return（==画不了==，且几乎没有反馈）。
 * 这个函数补上「从零开始」的能力：没有地形时给一个默认方框，有地形时按它的包围盒外扩。
 *
 * @param {Array} terrain 地形多边形数组（可为空）
 * @param {number} spacing 格子间距（世界单位）
 * @param {number} margin 外扩的格数
 */
export function buildGridFromTerrain(terrain, spacing = DEFAULT_GRID_SPACING, margin = 2) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of (terrain || [])) {
    for (const p of (poly && poly.points) || []) {
      const px = p.x ?? p[0] ?? 0;
      const py = p.y ?? p[1] ?? 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!Number.isFinite(minX)) {          // 空底图：给个默认方框，用户随后用笔刷涂就是了
    minX = -500; minY = -500; maxX = 500; maxY = 500;
  }
  minX -= spacing * margin; minY -= spacing * margin;
  maxX += spacing * margin; maxY += spacing * margin;

  const cols = Math.max(2, Math.ceil((maxX - minX) / spacing) + 1);
  const rows = Math.max(2, Math.ceil((maxY - minY) / spacing) + 1);
  const points = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points[r * cols + c] = [minX + c * spacing, minY + r * spacing];
    }
  }
  return { points, spacing, cellsX: cols, cellsY: rows, count: points.length };
}

/** 「解绑」：只摘掉绑定字段（行星侧那份保持不动，底图侧从 null 开始 —— 由 ensure 懒创建） */
export function planUnbindBaseMap(baseMap) {
  const next = { ...(baseMap || {}) };
  delete next[BASEMAP_PLANET_KEY];
  return { ok: true, nextBaseMap: next };
}
