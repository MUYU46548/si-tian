/**
 * utils/smartGuides.js — E5 智能参考线：拖拽时的对齐磁吸计算（纯函数）
 *
 * 用法：拖拽中用候选点集（其他对象的对齐点）对当前吸附位置做 X/Y 轴独立对齐，
 * 命中轴返回参考线（axis + coord），由绘制层画出贯穿视口的虚线。
 */

// 默认吸附阈值（屏幕像素，调用方按 1/zoom 换算成世界坐标）
export const SMART_SNAP_PX = 8;

/**
 * 拖拽对象的对齐候选点集（排除被拖对象自身）
 * 候选：标记/文本中心、聚落节点中心、区域包围盒的边中点与中心
 * @returns {Array<{x: number, y: number}>}
 */
export function buildSnapCandidates({ markers = [], textLabels = [], places = [], regions = [] }, exclude = {}) {
  const pts = [];
  const push = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y }); };

  markers.forEach(m => {
    if (exclude.type === 'marker' && m.id === exclude.id) return;
    push(m.x, m.y);
  });
  textLabels.forEach(l => {
    if (exclude.type === 'textLabel' && l.id === exclude.id) return;
    push(l.x, l.y);
  });
  places.forEach(p => {
    if (p.coordinate?.x == null || p.coordinate?.y == null) return;
    if (exclude.type === 'place' && p.id === exclude.id) return;
    push(p.coordinate.x, p.coordinate.y);
  });
  regions.forEach(r => {
    if (exclude.type === 'region' && r.id === exclude.id) return;
    if (!r.points || r.points.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    r.points.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    // 中心 + 四边中点：最常见的对齐意图
    push(cx, cy);
    push(minX, cy); push(maxX, cy);
    push(cx, minY); push(cx, maxY);
  });
  return pts;
}

/**
 * X/Y 轴独立对齐吸附
 * @param {{x: number, y: number}} pos 当前（网格吸附后）位置
 * @param {Array<{x, y}>} candidates 候选点
 * @param {number} threshold 世界坐标阈值（SMART_SNAP_PX / zoom）
 * @returns {{ x, y, guides: Array<{axis: 'v'|'h', coord: number}> }}
 */
export function computeSmartSnap(pos, candidates, threshold) {
  let snapX = null, bestDx = threshold;
  let snapY = null, bestDy = threshold;
  for (const c of candidates) {
    const dx = Math.abs(c.x - pos.x);
    if (dx < bestDx) { bestDx = dx; snapX = c.x; }
    const dy = Math.abs(c.y - pos.y);
    if (dy < bestDy) { bestDy = dy; snapY = c.y; }
  }
  const guides = [];
  let { x, y } = pos;
  if (snapX !== null) { x = snapX; guides.push({ axis: 'v', coord: snapX }); }
  if (snapY !== null) { y = snapY; guides.push({ axis: 'h', coord: snapY }); }
  return { x, y, guides };
}
