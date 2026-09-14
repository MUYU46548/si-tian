/**
 * utils/contour.js — 从离散标量场提取轮廓线（marching squares 简化版）
 *
 * 用于生物群系/高度图等网格数据的可视化轮廓提取。
 * 算法：遍历每个 2×2 单元格，检测相邻格子值不同的边，连成连续折线。
 *
 * 输出格式：[{ points: [{x, y}, ...], values: [v1, v2] }, ...]
 * 每条轮廓线连接两个不同值的边界。
 */

/**
 * 从离散标量场提取轮廓线
 * @param {Uint8Array|number[]} field - 一维数组，field[idx] = 格子值（如 biome 编码）
 * @param {number} cols - 列数
 * @param {number} rows - 行数
 * @param {Array} pts - 格子中心坐标 [[x,y], ...] 或 [{x,y}, ...]
 * @param {number} spacing - 格子间距（世界单位）
 * @returns {Array} contours - [{ points: [{x,y}, ...], values: [v1, v2] }, ...]
 */
export function extractContours(field, cols, rows, pts, spacing) {
  if (!field || !pts || field.length < 4 || pts.length < 4) return [];
  if (cols * rows > field.length || cols * rows > pts.length) return [];

  const half = spacing / 2;

  const val = (c, r) => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
    return field[r * cols + c];
  };

  const coord = (c, r) => {
    const p = pts[r * cols + c];
    return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
  };

  // 收集边：key = "c,r,dir" -> { x, y, valA, valB, c, r, dir }
  // dir: 'v' 垂直边 (c和c+1之间), 'h' 水平边 (r和r+1之间)
  const edges = new Map();

  // 垂直边
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const v1 = val(c, r);
      const v2 = val(c + 1, r);
      if (v1 !== v2 && v1 >= 0 && v2 >= 0) {
        const p1 = coord(c, r);
        const p2 = coord(c + 1, r);
        edges.set(`${c},${r},v`, {
          x: (p1.x + p2.x) / 2,
          y: (p1.y + p2.y) / 2,
          valA: v1, valB: v2, c, r, dir: 'v'
        });
      }
    }
  }

  // 水平边
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const v1 = val(c, r);
      const v2 = val(c, r + 1);
      if (v1 !== v2 && v1 >= 0 && v2 >= 0) {
        const p1 = coord(c, r);
        const p2 = coord(c, r + 1);
        edges.set(`${c},${r},h`, {
          x: (p1.x + p2.x) / 2,
          y: (p1.y + p2.y) / 2,
          valA: v1, valB: v2, c, r, dir: 'h'
        });
      }
    }
  }

  // 构建角到边的映射
  const cornerEdges = new Map();

  for (const [key, edge] of edges) {
    const { c, r, dir } = edge;
    let corners;
    if (dir === 'v') {
      corners = [`${c + 1},${r}`, `${c + 1},${r + 1}`];
    } else {
      corners = [`${c},${r + 1}`, `${c + 1},${r + 1}`];
    }
    for (const corner of corners) {
      if (!cornerEdges.has(corner)) cornerEdges.set(corner, []);
      cornerEdges.get(corner).push(key);
    }
  }

  // 遍历所有边，连成路径
  const visited = new Set();
  const contours = [];

  for (const startKey of edges.keys()) {
    if (visited.has(startKey)) continue;

    const path = [];
    let currentKey = startKey;

    while (currentKey && !visited.has(currentKey)) {
      visited.add(currentKey);
      const edge = edges.get(currentKey);
      path.push({ x: edge.x, y: edge.y, valA: edge.valA, valB: edge.valB });

      const m = currentKey.match(/(\d+),(\d+),([vh])/);
      if (!m) break;
      const cc = parseInt(m[1]), rr = parseInt(m[2]);

      let nextKey = null;
      if (m[3] === 'v') {
        for (const corner of [`${cc},${rr}`, `${cc},${rr + 1}`]) {
          const neighbors = cornerEdges.get(corner);
          if (neighbors) {
            for (const nk of neighbors) {
              if (nk !== currentKey && !visited.has(nk)) {
                nextKey = nk;
                break;
              }
            }
          }
          if (nextKey) break;
        }
      } else {
        for (const corner of [`${cc},${rr + 1}`, `${cc + 1},${rr + 1}`]) {
          const neighbors = cornerEdges.get(corner);
          if (neighbors) {
            for (const nk of neighbors) {
              if (nk !== currentKey && !visited.has(nk)) {
                nextKey = nk;
                break;
              }
            }
          }
          if (nextKey) break;
        }
      }

      currentKey = nextKey;
    }

    if (path.length >= 2) {
      contours.push({
        points: path.map(p => ({ x: p.x, y: p.y })),
        values: [path[0].valA, path[0].valB]
      });
    }
  }

  return contours;
}

/**
 * 简化轮廓线：Ramer-Douglas-Peucker 算法
 * @param {Array} points - [{x, y}, ...]
 * @param {number} epsilon - 简化阈值（世界单位）
 * @returns {Array} 简化后的点数组
 */
export function simplifyContour(points, epsilon = 2) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyContour(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyContour(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }

  return [first, last];
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq;
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

/**
 * 计算点集的凸包（Andrew's monotone chain 算法）
 * @param {Array} points - [{x, y}, ...]
 * @returns {Array} 凸包顶点（逆时针）
 */
export function convexHull(points) {
  if (points.length < 3) return points.slice();

  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

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
