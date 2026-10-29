// utils/heightThumb.js — 高度图缩略图（面板预览用的**唯一实现**，2026-10-29）
//
// 为什么要单独一份：`TerrainGenPanel`（按轮廓推演的候选）与 `FmgPanel`（FMG 模板候选）画的是
// 同一种东西 —— `{h, cols, rows}` 的三段色块图。两份各写一套，迟早出现"同一个高度在两块面板里
// 是两种颜色"（本项目在别处踩过：预览与出图不同色）。
//
// 配色就是画布已有的地形三档语义（海 / 低地 / 高地），不引第二套调色板。

export const THUMB_SEA_LEVEL = 20;

/**
 * 把一个高度场画到 2D 上下文里（**填满整个 ctx**，调用方自己决定 canvas 尺寸）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{h:ArrayLike<number>, cols:number, rows:number}} field
 * @param {{seaLevel?:number}} [opts]
 * @returns {boolean} 画了没有（空数据 / 尺寸非法 → false）
 */
export function drawHeightThumb(ctx, field, opts = {}) {
  if (!ctx || !field || !field.h || !field.h.length) return false;
  const cols = Math.max(1, Math.floor(field.cols) || 0);
  const rows = Math.max(1, Math.floor(field.rows) || 0);
  if (!cols || !rows) return false;
  const sea = Number.isFinite(opts.seaLevel) ? opts.seaLevel : THUMB_SEA_LEVEL;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const cw = W / cols;
  const ch = H / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = field.h[j * cols + i];
      let color;
      if (!(v >= sea)) {
        const t = Math.max(0, Math.min(1, (sea - v) / 8));
        color = `rgb(${30 + 20 * (1 - t)},${70 + 40 * (1 - t)},${110 + 40 * (1 - t)})`;
      } else {
        const t = Math.max(0, Math.min(1, (v - sea) / 60));
        color = `rgb(${Math.round(120 + 110 * t)},${Math.round(150 + 40 * t)},${Math.round(90 - 40 * t)})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(i * cw, j * ch, Math.ceil(cw) + 1, Math.ceil(ch) + 1);
    }
  }
  return true;
}
