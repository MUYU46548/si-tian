/**
 * 邻接吸附算法模块
 * 在多边形绘制完成后，将新省份的边缘贴合到相邻省份上
 * 实现拓扑关系而非独立多边形
 */

/**
 * 计算点到线段的最近点
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
 * 计算两线段之间的最短距离及对应点
 */
function segmentDistance(a1, a2, b1, b2) {
  // 检查是否相交
  if (segmentsIntersect(a1, a2, b1, b2)) {
    return { distance: 0, pointA: null, pointB: null };
  }
  
  // 四个端点到对边线段的距离
  const candidates = [
    { p: a1, closest: closestPointOnSegment(a1, b1, b2) },
    { p: a2, closest: closestPointOnSegment(a2, b1, b2) },
    { p: b1, closest: closestPointOnSegment(b1, a1, a2) },
    { p: b2, closest: closestPointOnSegment(b2, a1, a2) },
  ];
  
  let minDist = Infinity;
  let result = { distance: Infinity, pointA: null, pointB: null };
  
  for (const c of candidates) {
    const dist = Math.hypot(c.p.x - c.closest.x, c.p.y - c.closest.y);
    if (dist < minDist) {
      minDist = dist;
      const isA = candidates.indexOf(c) < 2;
      result = {
        distance: dist,
        pointA: isA ? c.p : c.closest,
        pointB: isA ? c.closest : c.p,
      };
    }
  }
  
  return result;
}

/**
 * 判断两线段是否相交
 */
function segmentsIntersect(a1, a2, b1, b2) {
  const d1 = direction(b1, b2, a1);
  const d2 = direction(b1, b2, a2);
  const d3 = direction(a1, a2, b1);
  const d4 = direction(a1, a2, b2);
  
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  
  if (d1 === 0 && onSegment(b1, b2, a1)) return true;
  if (d2 === 0 && onSegment(b1, b2, a2)) return true;
  if (d3 === 0 && onSegment(a1, a2, b1)) return true;
  if (d4 === 0 && onSegment(a1, a2, b2)) return true;
  
  return false;
}

function direction(p1, p2, p3) {
  return (p3.x - p1.x) * (p2.y - p1.y) - (p2.x - p1.x) * (p3.y - p1.y);
}

function onSegment(p1, p2, p) {
  return Math.min(p1.x, p2.x) <= p.x && p.x <= Math.max(p1.x, p2.x) &&
         Math.min(p1.y, p2.y) <= p.y && p.y <= Math.max(p1.y, p2.y);
}

/**
 * 将新多边形的顶点吸附到相邻多边形
 * @param {Object} newPoly - 新多边形 { points: [{x, y}, ...] }
 * @param {Array} existingPolygons - 现有相邻多边形数组
 * @param {Object} options - 配置选项
 * @returns {Object} { polygon, snappedCount }
 */
export function snapPolygonToNeighbors(newPoly, existingPolygons, options = {}) {
  const {
    vertexThreshold = 12,    // 顶点吸附阈值（世界坐标单位）
    edgeThreshold = 8,      // 边吸附阈值
    insertVertices = true,  // 是否在重叠处插入新顶点
  } = options;
  
  if (!existingPolygons || existingPolygons.length === 0) {
    return { polygon: newPoly, snappedCount: 0 };
  }
  
  const points = newPoly.points.map(p => ({ x: p.x, y: p.y }));
  let snappedCount = 0;
  
  // 第一步：顶点吸附 - 将新顶点吸附到最近的现有顶点或边上
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    let bestDist = vertexThreshold;
    let bestTarget = null;
    
    for (const other of existingPolygons) {
      if (!other.points || other.points.length < 3) continue;
      
      // 检查顶点
      for (const otherPt of other.points) {
        const dist = Math.hypot(pt.x - otherPt.x, pt.y - otherPt.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestTarget = { x: otherPt.x, y: otherPt.y };
        }
      }
      
      // 检查边
      for (let j = 0; j < other.points.length; j++) {
        const a = other.points[j];
        const b = other.points[(j + 1) % other.points.length];
        const closest = closestPointOnSegment(pt, a, b);
        const dist = Math.hypot(pt.x - closest.x, pt.y - closest.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestTarget = closest;
        }
      }
    }
    
    if (bestTarget) {
      points[i] = bestTarget;
      snappedCount++;
    }
  }
  
  // 第二步：边吸附 - 检测重叠边并在重叠处插入顶点
  if (insertVertices) {
    const newPoints = [];
    for (let i = 0; i < points.length; i++) {
      const curr = points[i];
      const next = points[(i + 1) % points.length];
      
      newPoints.push(curr);
      
      // 检查这条边是否靠近现有边
      for (const other of existingPolygons) {
        if (!other.points || other.points.length < 3) continue;
        
        for (let j = 0; j < other.points.length; j++) {
          const oa = other.points[j];
          const ob = other.points[(j + 1) % other.points.length];
          
          const { distance, pointA, pointB } = segmentDistance(curr, next, oa, ob);
          
          if (distance < edgeThreshold && pointA && pointB) {
            // 在重叠区域插入对方的顶点
            const insertPt = closestPointOnSegment(ob, curr, next);
            const distToCurr = Math.hypot(insertPt.x - curr.x, insertPt.y - curr.y);
            const distToNext = Math.hypot(insertPt.x - next.x, insertPt.y - next.y);
            const edgeLen = Math.hypot(next.x - curr.x, next.y - curr.y);
            
            // 只插入在边内部的点
            if (distToCurr > 2 && distToNext > 2 && distToCurr < edgeLen) {
              newPoints.push(insertPt);
            }
          }
        }
      }
    }
    
    return { polygon: { ...newPoly, points: newPoints }, snappedCount };
  }
  
  return { polygon: { ...newPoly, points }, snappedCount };
}

/**
 * 检测两个多边形是否邻接（共享边界或顶点）
 */
export function arePolygonsAdjacent(poly1, poly2, threshold = 15) {
  if (!poly1.points || !poly2.points) return false;
  
  for (const p1 of poly1.points) {
    for (const p2 of poly2.points) {
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (dist < threshold) return true;
    }
  }
  
  // 检查边是否靠近
  for (let i = 0; i < poly1.points.length; i++) {
    const a1 = poly1.points[i];
    const a2 = poly1.points[(i + 1) % poly1.points.length];
    
    for (let j = 0; j < poly2.points.length; j++) {
      const b1 = poly2.points[j];
      const b2 = poly2.points[(j + 1) % poly2.points.length];
      
      const { distance } = segmentDistance(a1, a2, b1, b2);
      if (distance < threshold) return true;
    }
  }
  
  return false;
}

/**
 * 获取与指定多边形相邻的所有多边形
 */
export function getAdjacentPolygons(targetPoly, allPolygons, threshold = 15) {
  return allPolygons.filter(p => 
    p.id !== targetPoly.id && arePolygonsAdjacent(targetPoly, p, threshold)
  );
}
