/**
 * floodfill.js — 区域填充算法
 * 
 * 将画布栅格化 → 标记已有省份占据的格子 → 从点击位置 BFS 漫延 →
 * 提取边界 → 简化多边形
 * 
 * 参考 Azgaar 的 Voronoi 分区思路，但用更简单的栅格 BFS 实现。
 */

/**
 * 判断点是否在多边形内（射线法）
 */
function pointInPolygon(x, y, points) {
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
 * 计算点到线段的垂直距离
 */
function perpendicularDistance(point, lineStart, lineEnd) {
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
 * Douglas-Peucker 路径简化
 */
function simplifyPath(points, tolerance) {
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

/**
 * 将多边形标记到栅格上
 */
function markPolygonOnGrid(grid, gridSize, bounds, points, value) {
  const cellW = (bounds.maxX - bounds.minX) / gridSize;
  const cellH = (bounds.maxY - bounds.minY) / gridSize;

  let minGX = Infinity, maxGX = -Infinity, minGY = Infinity, maxGY = -Infinity;
  for (const p of points) {
    const gx = Math.floor((p.x - bounds.minX) / cellW);
    const gy = Math.floor((p.y - bounds.minY) / cellH);
    minGX = Math.min(minGX, gx);
    maxGX = Math.max(maxGX, gx);
    minGY = Math.min(minGY, gy);
    maxGY = Math.max(maxGY, gy);
  }

  minGX = Math.max(0, minGX - 1);
  maxGX = Math.min(gridSize - 1, maxGX + 1);
  minGY = Math.max(0, minGY - 1);
  maxGY = Math.min(gridSize - 1, maxGY + 1);

  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      const wx = bounds.minX + (gx + 0.5) * cellW;
      const wy = bounds.minY + (gy + 0.5) * cellH;
      if (pointInPolygon(wx, wy, points)) {
        grid[gy * gridSize + gx] = value;
      }
    }
  }
}

/**
 * 提取填充区域的边界格子并排序
 */
function extractBoundaryCells(filled, gridSize) {
  const boundary = [];
  
  for (const idx of filled) {
    const x = idx % gridSize;
    const y = Math.floor(idx / gridSize);
    
    let isBoundary = false;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) {
        isBoundary = true;
        break;
      }
      if (!filled.has(ny * gridSize + nx)) {
        isBoundary = true;
        break;
      }
    }
    
    if (isBoundary) {
      boundary.push({ x, y });
    }
  }
  
  return boundary;
}

/**
 * 对边界格子排序（顺时针绕圈）
 */
function orderBoundaryCells(boundaryCells) {
  if (boundaryCells.length === 0) return [];
  
  // 找到最上最左的格子作为起点
  const sorted = [...boundaryCells].sort((a, b) => a.y - b.y || a.x - b.x);
  const visited = new Set();
  const ordered = [];
  
  let current = sorted[0];
  let dir = 0; // 0=右, 1=下, 2=左, 3=上
  
  do {
    ordered.push(current);
    visited.add(`${current.x},${current.y}`);
    
    let found = false;
    // 右转优先：依次尝试当前方向的右方、前方、左方、后方
    for (let i = 0; i < 4; i++) {
      const checkDir = (dir + 3 + i) % 4; // 右转优先
      const dirs = [[1,0],[0,1],[-1,0],[0,-1]];
      const [dx, dy] = dirs[checkDir];
      const next = { x: current.x + dx, y: current.y + dy };
      
      const key = `${next.x},${next.y}`;
      if (!visited.has(key) && boundaryCells.some(c => c.x === next.x && c.y === next.y)) {
        current = next;
        dir = checkDir;
        found = true;
        break;
      }
    }
    
    if (!found) break;
  } while (!(current.x === sorted[0].x && current.y === sorted[0].y));
  
  return ordered;
}

/**
 * 主函数：通过 flood-fill 生成新省份的多边形顶点
 * 
 * @param {number} clickX — 点击的世界坐标 X
 * @param {number} clickY — 点击的世界坐标 Y
 * @param {Array} existingPolygons — 已有省份的多边形列表
 * @param {Object} options — 配置参数
 * @returns {Array|null} — 简化后的多边形顶点，或 null（点击在已有省份内）
 */
export function createProvinceByFloodFill(clickX, clickY, existingPolygons, options = {}) {
  const {
    gridSize = 64,
    bounds = null,
    maxFillRatio = 0.25,
    simplifyTolerance = 10,
  } = options;

  // 动态计算边界
  const calcBounds = bounds || calculateBounds(existingPolygons, clickX, clickY);
  
  const cellW = (calcBounds.maxX - calcBounds.minX) / gridSize;
  const cellH = (calcBounds.maxY - calcBounds.minY) / gridSize;

  // 创建占用栅格：0=空, 1=已有省份
  const grid = new Uint8Array(gridSize * gridSize);

  for (const poly of existingPolygons) {
    if (poly.points && poly.points.length >= 3) {
      markPolygonOnGrid(grid, gridSize, calcBounds, poly.points, 1);
    }
  }

  // 转换点击坐标到栅格坐标
  const cx = Math.floor((clickX - calcBounds.minX) / cellW);
  const cy = Math.floor((clickY - calcBounds.minY) / cellH);

  // 边界检查
  if (cx < 0 || cx >= gridSize || cy < 0 || cy >= gridSize) return null;
  
  // 点击在已有省份内部 → 返回 null
  if (grid[cy * gridSize + cx] === 1) return null;

  // BFS flood fill
  const maxCells = Math.floor(gridSize * gridSize * maxFillRatio);
  const filled = new Set();
  const queue = [[cx, cy]];
  filled.add(cy * gridSize + cx);

  while (queue.length > 0 && filled.size < maxCells) {
    const [x, y] = queue.shift();
    
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x + dx;
      const ny = y + dy;
      
      if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
      const idx = ny * gridSize + nx;
      
      if (filled.has(idx) || grid[idx] === 1) continue;
      filled.add(idx);
      queue.push([nx, ny]);
    }
  }

  if (filled.size === 0) return null;

  // 提取并排序边界
  const boundaryCells = extractBoundaryCells(filled, gridSize);
  if (boundaryCells.length < 3) return null;
  
  const orderedCells = orderBoundaryCells(boundaryCells);
  if (orderedCells.length < 3) return null;

  // 转换为世界坐标
  const worldPoints = orderedCells.map(cell => ({
    x: calcBounds.minX + (cell.x + 0.5) * cellW,
    y: calcBounds.minY + (cell.y + 0.5) * cellH,
  }));

  // 简化多边形
  return simplifyPath(worldPoints, simplifyTolerance);
}

/**
 * 根据已有地形和点击位置计算边界
 */
function calculateBounds(existingPolygons, clickX, clickY) {
  let minX = clickX - 200, maxX = clickX + 200;
  let minY = clickY - 200, maxY = clickY + 200;

  for (const poly of existingPolygons) {
    if (!poly.points) continue;
    for (const p of poly.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }

  // 确保最小范围
  if (maxX - minX < 400) {
    const cx = (minX + maxX) / 2;
    minX = cx - 200;
    maxX = cx + 200;
  }
  if (maxY - minY < 400) {
    const cy = (minY + maxY) / 2;
    minY = cy - 200;
    maxY = cy + 200;
  }

  // 添加 padding
  const padding = 50;
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
  };
}

/**
 * 预览模式：计算 flood-fill 结果但不简化（用于 hover 显示）
 */
export function previewFloodFill(clickX, clickY, existingPolygons, options = {}) {
  return createProvinceByFloodFill(clickX, clickY, existingPolygons, {
    ...options,
    simplifyTolerance: 0, // 不简化，保留栅格感或单独处理
  });
}
