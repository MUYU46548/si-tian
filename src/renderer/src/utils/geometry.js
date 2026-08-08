/**
 * geometry.js — 多边形拓扑校验工具
 * 
 * 提供自相交检测、多边形有效性校验、有向面积计算等功能
 */

/**
 * 计算方向（叉积符号）
 */
function direction(p1, p2, p3) {
  return (p3.x - p1.x) * (p2.y - p1.y) - (p2.x - p1.x) * (p3.y - p1.y);
}

/**
 * 检测两线段是否严格相交（不包含端点重合的情况）
 */
function segmentsIntersectStrict(a1, a2, b1, b2) {
  const d1 = direction(b1, b2, a1);
  const d2 = direction(b1, b2, a2);
  const d3 = direction(a1, a2, b1);
  const d4 = direction(a1, a2, b2);
  
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

/**
 * 检测多边形自相交
 * @param {Array} points - 多边形顶点数组 [{x, y}, ...]
 * @returns {Array} 相交的线段对索引数组 [{edge1, edge2}, ...]
 */
export function detectSelfIntersection(points) {
  const intersections = [];
  const n = points.length;
  
  if (n < 4) return intersections;
  
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    
    for (let j = i + 2; j < n; j++) {
      // 跳过相邻边（共享顶点的边）
      if (j === (i + 1) % n || (i === 0 && j === n - 1)) continue;
      
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      
      if (segmentsIntersectStrict(a1, a2, b1, b2)) {
        intersections.push({ edge1: i, edge2: j });
      }
    }
  }
  return intersections;
}

/**
 * 检测多边形是否有效
 * @param {Array} points - 多边形顶点数组
 * @returns {Object} { valid: boolean, errors: Array }
 */
export function validatePolygon(points) {
  const errors = [];
  
  if (!points || points.length < 3) {
    errors.push({ type: 'too-few-vertices', message: '多边形至少需要 3 个顶点' });
    return { valid: false, errors };
  }
  
  // 检查 NaN/Infinity
  for (let i = 0; i < points.length; i++) {
    if (!isFinite(points[i].x) || !isFinite(points[i].y)) {
      errors.push({ type: 'invalid-vertex', index: i, message: `顶点 ${i} 坐标无效` });
    }
  }
  
  // 如果有无效坐标，直接返回（后续检查依赖有效坐标）
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  
  // 检查重复相邻顶点
  for (let i = 1; i < points.length; i++) {
    if (points[i].x === points[i-1].x && points[i].y === points[i-1].y) {
      errors.push({ type: 'duplicate-vertex', index: i, message: `顶点 ${i} 与前一个顶点重合` });
    }
  }
  
  // 检查首尾闭合（GeoJSON 标准要求）
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x !== last.x || first.y !== last.y) {
      // 对于首尾不相交的情况，某些实现允许（隐式闭合）
      // 这里仅作为警告级别，不标记为无效
    }
  }
  
  // 检查自相交
  const selfIntersections = detectSelfIntersection(points);
  if (selfIntersections.length > 0) {
    errors.push({ 
      type: 'self-intersecting', 
      count: selfIntersections.length,
      edges: selfIntersections,
      message: `多边形有 ${selfIntersections.length} 处自相交` 
    });
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * 计算多边形面积（Shoelace 公式，有向面积）
 * @param {Array} points - 多边形顶点数组
 * @returns {number} 有向面积（正值为逆时针，负值为顺时针）
 */
export function signedArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

/**
 * 计算多边形面积（绝对值）
 */
export function polygonArea(points) {
  return Math.abs(signedArea(points));
}

/**
 * 检测点是否在多边形内（射线法）
 * @param {number} x - 点的 X 坐标
 * @param {number} y - 点的 Y 坐标
 * @param {Array} points - 多边形顶点数组
 * @returns {boolean}
 */
export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 获取点到线段的最近点
 */
export function closestPointOnSegment(point, segStart, segEnd) {
  const dx = segEnd.x - segStart.x;
  const dy = segEnd.y - segStart.y;
  const lenSq = dx * dx + dy * dy;
  
  if (lenSq === 0) return { x: segStart.x, y: segStart.y };
  
  let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  
  return {
    x: segStart.x + t * dx,
    y: segStart.y + t * dy,
  };
}

/**
 * 计算点到线段的垂直距离
 */
export function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (len * len);
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}
