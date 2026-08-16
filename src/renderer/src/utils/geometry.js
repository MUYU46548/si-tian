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

/**
 * 凸包（Andrew's monotone chain）
 * @param {Array} points - [{x, y}, ...]
 * @returns {Array} 凸包顶点（逆时针顺序）
 */
export function convexHull(points) {
  if (!points || points.length < 3) return points ? [...points] : [];
  
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * 多边形中心（顶点平均）
 */
export function polygonCenter(points) {
  if (!points || points.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

/**
 * 沿中心向外扩展多边形
 * @param {Array} points - 多边形顶点
 * @param {number} distance - 外扩距离
 * @returns {Array} 外扩后的顶点
 */
export function expandPolygon(points, distance) {
  if (!points || points.length === 0) return [];
  const center = polygonCenter(points);
  return points.map(p => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const dist = Math.hypot(dx, dy) || 1;
    return {
      x: p.x + (dx / dist) * distance,
      y: p.y + (dy / dist) * distance,
    };
  });
}

// ===== 省份拆分/合并（2026-08-16） =====

function lineIntersection(p1, p2, q1, q2) {
  const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
  const dx2 = q2.x - q1.x, dy2 = q2.y - q1.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((q1.x - p1.x) * dy2 - (q1.y - p1.y) * dx2) / denom;
  return { x: p1.x + t * dx1, y: p1.y + t * dy1 };
}

function onSegment(a, b, p) {
  return Math.min(a.x, b.x) - 1e-6 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-6 &&
         Math.min(a.y, b.y) - 1e-6 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-6;
}

/**
 * 线段求交（含端点接触）
 */
function segmentIntersection(p1, p2, q1, q2) {
  const d1 = direction(p1, p2, q1);
  const d2 = direction(p1, p2, q2);
  const d3 = direction(q1, q2, p1);
  const d4 = direction(q1, q2, p2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return lineIntersection(p1, p2, q1, q2);
  }
  if (d1 === 0 && onSegment(p1, p2, q1)) return { x: q1.x, y: q1.y };
  if (d2 === 0 && onSegment(p1, p2, q2)) return { x: q2.x, y: q2.y };
  if (d3 === 0 && onSegment(q1, q2, p1)) return { x: p1.x, y: p1.y };
  if (d4 === 0 && onSegment(q1, q2, p2)) return { x: p2.x, y: p2.y };
  return null;
}

function dedupeAdjacent(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) {
    out.pop();
  }
  return out;
}

/**
 * 沿切割线拆分多边形为两个
 * @param {Array} points - 多边形顶点（有序）
 * @param {Object} lineA - 切割线起点（世界坐标）
 * @param {Object} lineB - 切割线终点
 * @returns {Array|null} [poly1, poly2] 两个闭合多边形；切割线未穿过时返回 null
 */
export function splitPolygon(points, lineA, lineB) {
  const n = points.length;
  if (n < 4) return null;

  const cuts = [];
  // 用「无限直线」求交：切割线两端可能都在多边形内部（用户在多边形内点两点），
  // 线段求交会因端点在内而找不到交点（bug 2026-08-16：20→380 内部切割失败）
  for (let i = 0; i < n; i++) {
    const p1 = points[i], p2 = points[(i + 1) % n];
    const d1 = direction(lineA, lineB, p1);
    const d2 = direction(lineA, lineB, p2);
    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
      const inter = lineIntersection(lineA, lineB, p1, p2);
      if (inter) {
        const dup = cuts.some(c => Math.hypot(c.point.x - inter.x, c.point.y - inter.y) < 1e-6);
        if (!dup) cuts.push({ edgeIndex: i, point: inter });
      }
    }
  }
  if (cuts.length < 2) return null;

  // 沿切割线方向投影，取跨度最大的两个交点
  const dx = lineB.x - lineA.x, dy = lineB.y - lineA.y;
  const denom = dx * dx + dy * dy || 1;
  cuts.forEach(c => {
    c.t = ((c.point.x - lineA.x) * dx + (c.point.y - lineA.y) * dy) / denom;
  });
  cuts.sort((a, b) => a.t - b.t);
  const cut1 = cuts[0];
  const cut2 = cuts[cuts.length - 1];

  // 正向路径：cut1 → 沿多边形轮廓 → cut2
  const polyA = [cut1.point];
  for (let step = 1; step <= n; step++) {
    const idx = (cut1.edgeIndex + step) % n;
    polyA.push(points[idx]);
    if (idx === cut2.edgeIndex) {
      polyA.push(cut2.point);
      break;
    }
  }
  // 反向路径：cut2 → 沿多边形轮廓 → cut1
  const polyB = [cut2.point];
  for (let step = 1; step <= n; step++) {
    const idx = (cut2.edgeIndex + step) % n;
    polyB.push(points[idx]);
    if (idx === cut1.edgeIndex) {
      polyB.push(cut1.point);
      break;
    }
  }

  const a = dedupeAdjacent(polyA);
  const b = dedupeAdjacent(polyB);
  if (a.length < 3 || b.length < 3) return null;
  return [a, b];
}

/**
 * 合并两个多边形为一个
 * 优先共边合并（顶点距离 < tolerance 判定），否则最近顶点桥接
 * @param {Array} poly1
 * @param {Array} poly2
 * @param {number} tolerance - 共边判定容差（世界坐标 px，默认 10）
 * @returns {Array} 合并后的多边形顶点
 */
export function mergePolygons(poly1, poly2, tolerance = 10) {
  const p1 = [...poly1];
  const p2 = [...poly2];

  // 方案 A：共边合并（两多边形共享一条近似重合的边）
  for (let i = 0; i < p1.length; i++) {
    const a1 = p1[i], a2 = p1[(i + 1) % p1.length];
    for (let j = 0; j < p2.length; j++) {
      const b1 = p2[j], b2 = p2[(j + 1) % p2.length];
      const reverseShared = Math.hypot(a1.x - b2.x, a1.y - b2.y) < tolerance &&
                            Math.hypot(a2.x - b1.x, a2.y - b1.y) < tolerance;
      const sameShared = Math.hypot(a1.x - b1.x, a1.y - b1.y) < tolerance &&
                         Math.hypot(a2.x - b2.x, a2.y - b2.y) < tolerance;
      if (reverseShared || sameShared) {
        const merged = [];
        for (let k = 1; k <= p1.length; k++) merged.push(p1[(i + k) % p1.length]);
        for (let k = 1; k <= p2.length; k++) merged.push(p2[(j + k) % p2.length]);
        const out = dedupeAdjacent(merged);
        return out.length >= 3 ? out : null;
      }
    }
  }

  // 方案 B：最近顶点桥接（不相邻多边形，形成哑铃轮廓）
  let best = { dist: Infinity, i: -1, j: -1 };
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      const d = Math.hypot(p1[i].x - p2[j].x, p1[i].y - p2[j].y);
      if (d < best.dist) best = { dist: d, i, j };
    }
  }
  if (best.i === -1) return null;
  const merged = [];
  for (let k = 0; k < p1.length; k++) merged.push(p1[(best.i + k) % p1.length]);
  merged.push(p2[best.j]);
  for (let k = 1; k < p2.length; k++) merged.push(p2[(best.j + k) % p2.length]);
  merged.push({ ...p1[best.i] });
  const out = dedupeAdjacent(merged);
  return out.length >= 3 ? out : null;
}

/**
 * 路径简化（Douglas-Peucker，2026-08-16 自 PlanetMap 迁入）
 * @param {Array} points - 顶点数组
 * @param {number} tolerance - 简化容差
 * @returns {Array} 简化后顶点
 */
export function simplifyPath(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = simplifyPath(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPath(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  } else {
    return [points[0], points[end]];
  }
}
