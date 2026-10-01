/**
 * 剧本地图的**配色单一来源**（2026-10-01）。
 *
 * 为什么单独一个模块：这些常量原先散在三个文件里 —— 省份色板与海域色在 `ScenarioMap.vue`，
 * 边界色在 `composables/useScenarioExport.js`，兜底色板在 `composables/useProvinceBrush.js`。
 * 导出链与画布一旦各持一份，就会出现「画布上是水域蓝、导出图里是灰」这类**不报错的**不一致
 * （本项目已在高度图 / 参考图 / 势力名三处各付过一次代价）。
 *
 * ⚠️ 只放「颜色常量」，不放算法 —— 海域判据（`kind === 'sea'`）在 `provinceRings` /
 *    `resolveProvinceKind` 那一层，别在这里再判一次。
 */

/** 新建省份的色板轮转（确定性 —— 颜色不随机，测试可断言、用户可预期） */
export const PROVINCE_PALETTE = Object.freeze([
  '#9ec9a8', '#c9b48a', '#a99ac9', '#c99a9a', '#8fb8c9',
  '#c9c48a', '#b8a4c9', '#8ac9bb', '#c9a88f', '#a4b8c9',
]);

/** 下一个省份色（按已存在省份数轮转） */
export function nextProvinceColor(count) {
  return PROVINCE_PALETTE[count % PROVINCE_PALETTE.length];
}

/**
 * P4：海域（`kind === 'sea'`）有自己的视觉 —— 淡色水面 + **淡虚线海界**
 * （虚线是「这是水域」的约定），且**不参与势力归属着色**（海不是谁的领土）。
 * 导出链必须用同一对颜色，否则水面与陆地分不开。
 */
export const SEA_FILL = 'rgba(74, 118, 158, 0.42)';
export const SEA_EDGE = 'rgba(206, 228, 244, 0.75)';

/** 陆地省界色（画布与 SVG 导出共用；海界用 SEA_EDGE + 虚线区分） */
export const BORDER_COLOR = '#8d8a82';
