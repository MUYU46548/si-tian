// utils/biomeColors.js — 群系 → 颜色（**唯一实现**，2026-11-05）
//
// 为什么单独抽出来：`ScenarioMap` 与 `PlanetMap` 原先各写了一份 `BIOME_COLORS`，
// 而且已经漂移（行星那份漏了 `land`）—— 两份实现不会报错，只会"改一处另一处不变"。
// 两边画的是同一套群系数据，颜色必须同源（本项目在"省份色 / 派生命名 / 海色"上各栽过一次）。
//
// ⚠️ `temperate` 是司天自己的**默认群系**（`scenarioEditing.js` 里 `biome || 'temperate'`），
//    表必须覆盖所有会被写进去的群系名 —— 漏一个不是"少个颜色"，而是整块大陆落兜底色
//    （2026-10-09 实测：暮雨导入的底图看着像"没上色"）。

export const BIOME_COLORS = {
  ocean: '#2E86AB',
  hot_desert: '#E9C46A',
  cold_desert: '#B5B887',
  savanna: '#D2D082',
  grassland: '#C8D68F',
  tropical_seasonal: '#B6D95D',
  temperate: '#5FA85C',
  temperate_deciduous: '#29BC56',
  tropical_rainforest: '#7DCB35',
  temperate_rainforest: '#409C43',
  taiga: '#4B6B32',
  tundra: '#96784B',
  glacier: '#D5E7EB',
  wetland: '#0B9131',
  land: '#A3C4BC',
};

export default BIOME_COLORS;
