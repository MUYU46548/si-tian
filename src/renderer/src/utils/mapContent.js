// utils/mapContent.js —— 「这张行星地图有没有东西」的**唯一判定**（2026-11-01）
//
// ── 为什么需要它（真实报障）────────────────────────────────────────────────
// 用户 2026-11-01 原话：「行星地图有一堆早期测试遗留笔刷产物，却每次都告诉我『这张行星地图还是空的』」。
// 根因：`composables/useAutoRegions.js` 里的 `fogMode` 只认两样东西 ——
//   `terrain.length > 0 || regions.length > 0`
// 于是**只要那张图是用笔刷涂出来的**（`terrainGrid` 地形格 / `heightmap.h` 高度 / 通道笔刷
// `heightmap.culture|religion` / 河流 / 道路 / 标记 / 文字 / Azgaar 省份），
// 判定就一直是「空」：既画雾、又盖「还是空的」提示卡 —— 数据明明在，界面说没有。
//
// ── 判据口径 ───────────────────────────────────────────────────────────────
// 「有内容」= **画布会画出任何东西**。所以这里列的是渲染层真正消费的全部容器，
// 而不是某两样。反过来，**只有参看图（referenceImages）不算内容**：那只是一张对照底图，
// 底图之上没有任何司天自己的数据时，说它「空」是诚实的。
//
// ⚠️ 加新的地图容器时，**必须在这里登记**（否则就回到「画得出来却被判空」的老毛病）。
//    `test_map_content.js` 守这条口径。

/**
 * **地图本体**（非空数组即内容）：画在底图上的东西。
 * ⚠️ 口径：这里判的是「这张**底图**有没有东西」，给空态卡/雾用 —— 空态卡提供的是
 *    「导入 .map 底图 / 开始绘制」，所以只有**标注**（标记 / 文字 / 聚簇）不算底图。
 *    用户 2026-11-01 报障的是"笔刷产物被判空"：笔刷产物走 `terrainGrid` / `heightmap`，
 *    都在这份清单里（见下），所以修得到。
 */
const ARRAY_FIELDS = [
  'terrain',        // 地形多边形
  'regions',        // 区域多边形
  'rivers',         // 河流折线（v2：nodes）
  'routes',         // 道路
  'azgaarProvinces',// .map 导入的省份
  'azgaarStates',   // .map 导入的国家
  'lakes',          // 湖泊
];

/** 纯标注（不算"底图有东西"，但也不丢）：留个名字，防止后来者以为是漏登记 */
export const ANNOTATION_FIELDS = ['markers', 'textLabels', 'clusters'];

/** 高度图里的通道（TypedArray / 普通数组，值 0 = 没画） */
const CHANNEL_FIELDS = ['h', 'biome', 'culture', 'religion'];

/** 数组 / TypedArray 里是否存在非零值（0 = 空位，与笔刷口径一致） */
export function hasAnyValue(arr) {
  if (!arr || typeof arr.length !== 'number' || arr.length === 0) return false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === 0 || v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    return true;
  }
  return false;
}

/**
 * 这张行星地图有没有内容。
 * @param {object|null|undefined} mapData `mapData[planetId]`
 * @returns {boolean}
 */
export function mapHasContent(mapData) {
  const md = mapData;
  if (!md || typeof md !== 'object') return false;

  for (const key of ARRAY_FIELDS) {
    const v = md[key];
    if (Array.isArray(v) && v.length > 0) return true;
  }

  // 地形涂格（笔刷产物，8 类地形；0 = 没涂）
  if (hasAnyValue(md.terrainGrid)) return true;
  if (md.terrainGrid && hasAnyValue(md.terrainGrid.grid)) return true;

  // 高度图各通道（高度 / 群系 / 文化 / 宗教）
  const hm = md.heightmap;
  if (hm && typeof hm === 'object') {
    for (const key of CHANNEL_FIELDS) {
      if (hasAnyValue(hm[key])) return true;
    }
  }

  return false;
}

/**
 * 人话版说明：为什么判空 / 判不空（给提示卡与诊断用）。
 * @returns {{empty:boolean, reason:string}}
 */
export function describeMapContent(mapData) {
  if (mapHasContent(mapData)) return { empty: false, reason: 'has-content' };
  return { empty: true, reason: 'no-layers' };
}
