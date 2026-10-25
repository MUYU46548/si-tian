// utils/landmassRelief.js — **地形底图的配色（唯一实现）**：造陆面板缩略图与出图工具共用
//
// 为什么单独一个文件：`LandmassPanel.vue`（画布 ImageData）与
// `scripts/tests/tools/render_landmass_preview.mjs`（纯 Node 光栅）都要把同一份高度栅格
// 染成"海/低地/山地/雪线"。两边各写一套色带，结果就是**面板里的山和出图里的山不是一个颜色**
// —— 这种不一致不会报错，只会让人"总觉得预览和实际不一样"（本仓反复踩过同款）。
//
// 口径：
//   · 水面按**深度**分两档（深海 / 近岸浅水），海平面处偏青；
//   · 陆地按**相对高度**（0 = 海平面，1 = 100）走五段色带：滩 → 低地 → 丘陵 → 山地 → 雪；
//   · 全部是 [r,g,b] 整数，调用方自己决定要不要再叠山体阴影。

/** 海平面（与 `heightMath.SEA_LEVEL` / `landmassField.SEA_LEVEL` 同口径） */
export const RELIEF_SEA_LEVEL = 20;

/** 陆地色带（位置 0..1 = 从海岸到最高点） */
export const RELIEF_LAND_STOPS = Object.freeze([
  [0.00, '#7f9a5e'],   // 海岸滩涂（偏绿）
  [0.18, '#9aad6a'],   // 低地
  [0.42, '#c3b183'],   // 丘陵（黄褐）
  [0.68, '#a98a63'],   // 山地（棕）
  [0.86, '#c9bfae'],   // 高山（灰）
  [1.00, '#efeeea'],   // 雪线
]);

const hex2rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const LAND = RELIEF_LAND_STOPS.map(([t, hex]) => [t, hex2rgb(hex)]);
const SEA_DEEP = [21, 33, 54];
const SEA_SHALLOW = [44, 74, 104];

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 高度 → 颜色。
 * @param {number} h 高度（0..100）
 * @param {number} [seaLevel] 海平面（默认 20；造陆的动态海平面是分位数，别写死）
 * @returns {[number,number,number]}
 */
export function reliefRgb(h, seaLevel = RELIEF_SEA_LEVEL) {
  const sea = Number.isFinite(seaLevel) ? seaLevel : RELIEF_SEA_LEVEL;
  const v = Number.isFinite(h) ? h : sea;
  if (v < sea) {
    // 深度：海平面以下每 8 个高度点从浅水过渡到深水
    const t = Math.max(0, Math.min(1, (sea - v) / 8));
    return [
      Math.round(lerp(SEA_SHALLOW[0], SEA_DEEP[0], t)),
      Math.round(lerp(SEA_SHALLOW[1], SEA_DEEP[1], t)),
      Math.round(lerp(SEA_SHALLOW[2], SEA_DEEP[2], t)),
    ];
  }
  const t = Math.max(0, Math.min(1, (v - sea) / Math.max(1, 100 - sea)));
  for (let i = 1; i < LAND.length; i++) {
    const [t1, c1] = LAND[i];
    if (t <= t1) {
      const [t0, c0] = LAND[i - 1];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return [
        Math.round(lerp(c0[0], c1[0], u)),
        Math.round(lerp(c0[1], c1[1], u)),
        Math.round(lerp(c0[2], c1[2], u)),
      ];
    }
  }
  return LAND[LAND.length - 1][1].slice();
}
