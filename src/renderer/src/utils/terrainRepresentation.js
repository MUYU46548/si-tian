// utils/terrainRepresentation.js — 「这片地形到底该画什么」的唯一判定（M2/A2 第二步，2026-09-25）
//
// ── 要解决的问题 ─────────────────────────────────────────────────────────────
// 「三套表示并存」的最后一块：`terrain[]` 多边形此前是 PlanetMap 的**地形主表示**（不透明实色），
// 而高度图只是一个默认关闭的叠加层 —— 于是用户看到的是「手绘几何编辑器」的多边形色块，
// 而不是高度图渲染出的连续地形（ROADMAP 的 A2 条目，蓝图阶段 5 的目标）。
//
// ── 决策：地形改为**高度图驱动**，多边形退为**可选覆盖物** ──────────────────────
//   · 行星有高度图 → 高度图是地形主表示；多边形默认**不画**，由「多边形」图层显式打开
//     （打开时半透明叠加，便于与高度图对照；编辑多边形时自动亮起，否则「看不见就点不到」）
//   · 行星**没有**高度图（自建底图 / 旧多边形地图）→ 多边形照旧是主表示、照旧不透明
//     **零行为变更**，这是本步的兼容性底线
//
// ── 为什么必须是**一处**判定 ─────────────────────────────────────────────────
// 同一件事要在三个地方回答（画布渲染 / 命中检测 / 导出 PNG·SVG）。三处各写一遍 `if`，
// 就是又一个「改一处另两处不变」的双源 —— 而且它不会报错，只会让导出图与画布慢慢分叉。
// 本模块是**纯函数**（不碰 store / 不碰 Vue），渲染、命中、导出三处共用，Node 侧可单测。
//
// ⚠️ 图层开关（`layers.planet.*`）是**全局单例**，而「有没有高度图」是**每颗行星各自的**。
//    所以不能用「把某个开关的默认值改掉」来实现 —— 必须由数据驱动判定，本模块即是。

/** 多边形作为**叠加覆盖物**时的不透明度（底下是高度图，要能同时看见两者） */
export const POLYGON_OVERLAY_ALPHA = 0.5;

/** 高度图单独作为主表示时的不透明度（不透明，否则会透出画布背景） */
export const HEIGHTMAP_BASE_ALPHA = 1;

/** 高度图与多边形叠加同显时的不透明度（沿用既有取值：矢量 0.7 / 栅格 0.85） */
// ⚠️ 取值统一为 0.75：两套渲染原来的叠加取值并不一致（矢量 0.7 / 栅格 0.85），
//    统一正是本步的目的之一 —— 同一份高度图在两个视图（乃至同一视图的两档配色）下观感一致。
export const HEIGHTMAP_OVERLAY_ALPHA = 0.75;

/**
 * 这份高度图是否**有内容可画**。
 *
 * 判据取「网格点 + 值数组都非空」，不看数值本身：用户可能就想要一个平坦世界（全 0 也是内容），
 * 按数值判「有没有画过」会静默吞掉这种合法数据。
 * （网格是否可用沿用 `heightmapAccess.hasGrid` 的口径：`grid.points` 非空数组。）
 */
export function hasHeightmapContent(heightmap) {
  if (!heightmap) return false;
  const grid = heightmap.grid;
  if (!grid || !Array.isArray(grid.points) || grid.points.length === 0) return false;
  const h = heightmap.h;
  return !!(h && h.length);
}

/**
 * 解析当前该画的地形表示 —— **纯函数，只回答"画什么"，不画**。
 *
 * @param {object} o
 * @param {object|null} o.heightmap      当前该用的高度图（由 `resolveHeightmap` 决定是哪一份）
 * @param {boolean} o.terrainVisible     「地形」图层开关（地形总开关）
 * @param {boolean} o.polygonsVisible    「多边形（覆盖物）」图层开关
 * @param {boolean} o.editing            正在编辑多边形（绘制/移动模式）→ 强制显示，否则点不到
 * @param {boolean} o.forceHeightmap     绕过总开关强制显示高度图（高度笔刷进行中：涂了必须看得见）
 * @returns {{
 *   hasHeightmap: boolean,
 *   source: 'heightmap'|'polygon'|'none',
 *   drawHeightmap: boolean, heightmapAlpha: number,
 *   drawPolygons: boolean, polygonAlpha: number
 * }}
 */
export function resolveTerrainRepresentation({ heightmap, terrainVisible, polygonsVisible, editing, forceHeightmap } = {}) {
  const hasHm = hasHeightmapContent(heightmap);
  const baseOn = !!terrainVisible;
  const overlayOn = !!polygonsVisible;
  const isEditing = !!editing;

  if (hasHm) {
    // 地形由高度图驱动。多边形只在「显式打开覆盖物」或「正在编辑」时出现。
    const drawHeightmap = baseOn || !!forceHeightmap;
    const drawPolygons = overlayOn || isEditing;
    return {
      hasHeightmap: true,
      source: drawHeightmap ? 'heightmap' : (drawPolygons ? 'polygon' : 'none'),
      drawHeightmap,
      // 多边形叠加时高度图半透明（两者都要看得见）；单独作底时实色（否则透出画布背景）
      heightmapAlpha: drawPolygons ? HEIGHTMAP_OVERLAY_ALPHA : HEIGHTMAP_BASE_ALPHA,
      drawPolygons,
      // 与高度图同显 → 半透明叠加；地形底图关掉后它就是唯一的地形显示 → 实色
      polygonAlpha: (drawHeightmap && !isEditing) ? POLYGON_OVERLAY_ALPHA : 1,
    };
  }

  // 没有高度图（自建底图 / 旧多边形地图）：多边形仍是主表示，**照旧不透明** → 零行为变更。
  const drawPolygons = baseOn || overlayOn || isEditing;
  return {
    hasHeightmap: false,
    source: drawPolygons ? 'polygon' : 'none',
    drawHeightmap: false,
    heightmapAlpha: HEIGHTMAP_BASE_ALPHA,
    drawPolygons,
    polygonAlpha: 1,
  };
}

/** 判定用到的图层 id（渲染 / 命中 / 导出三处必须取同一组，避免拼错字符串） */
export const TERRAIN_LAYER_ID = 'terrain';
export const TERRAIN_POLYGONS_LAYER_ID = 'terrainPolygons';
