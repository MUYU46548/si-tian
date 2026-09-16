// utils/viewport.js — 视口世界范围换算（P0-4 小地图共用）
//
// 小地图需要区分两种"边界"：
//   · worldBounds = 内容边界（全图范围，用于等比缩略）
//   · viewBounds  = 视口边界（镜头当前看到的世界矩形，用于绘制遮罩）
// 历史上 AreaMap / InteriorView 把两者混为一谈（worldBounds = viewBounds = 内容边界），
// 导致缩略图上视口遮罩恒等于整张图 —— 遮罩看不出位置，拖动也无从谈起。
//
// 本模块只做一件事：从 renderer.viewTransform + canvas 尺寸反解视口矩形。
// 与 PlanetMap 内联的同名算法保持一致（write once, reuse）。

/**
 * 由 renderer 的 viewTransform 反解当前视口的世界坐标矩形。
 *
 * @param {{viewTransform?: {x:number,y:number,scale:number}}} renderer useCanvasRenderer 返回值
 * @param {HTMLCanvasElement|null} canvasEl 画布元素（取 clientWidth/clientHeight）
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} fallback 画布未挂载时的回落范围
 * @returns {{minX:number,maxX:number,minY:number,maxY:number}}
 */
export function computeViewBounds(renderer, canvasEl, fallback) {
  const fb = fallback || { minX: -500, maxX: 500, minY: -500, maxY: 500 };
  const vt = renderer && renderer.viewTransform;
  if (!vt || !canvasEl) return { ...fb };
  const cw = canvasEl.clientWidth || canvasEl.width;
  const ch = canvasEl.clientHeight || canvasEl.height;
  if (!cw || !ch || !vt.scale) return { ...fb };
  const w = cw / vt.scale;
  const h = ch / vt.scale;
  const cx = -vt.x / vt.scale;
  const cy = -vt.y / vt.scale;
  return { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 };
}

/** 把内容边界向外扩一圈，避免缩略图上边缘元素贴边被裁 */
export function expandBounds(bounds, padding = 0) {
  return {
    minX: bounds.minX - padding,
    maxX: bounds.maxX + padding,
    minY: bounds.minY - padding,
    maxY: bounds.maxY + padding,
  };
}
