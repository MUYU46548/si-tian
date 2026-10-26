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
 * 连续标量场 → **等值线**（marching squares，带线性插值；2026-10-26）。
 *
 * 与上面 `extractContours` 的区别（别混用）：
 *   · `extractContours` 处理**分类场**（biome 这类整数编码），只找"相邻格值不同"的边，
 *     输出的是**格边中点**连成的阶梯线 —— 拿来画等深线会是满屏方格；
 *   · 本函数处理**连续场**（高度 / 海深 t），在格边内部按线性插值求交点，
 *     所以线是**平滑斜穿**格子的，档位换一个值线就整体移动，不会锁在格边上。
 *
 * 用途：海面等深线（`seaDepth.SEA_DEPTH_LEVELS`）、以及没有 `landFeatures` 时兜底海岸线
 * （在高度场上取 `SEA_LEVEL`）。
 *
 * ⚠️ 鞍点（对角两高两低的 5 / 10 两种编码）：按**中心均值**决定连法（asymptotic decider）。
 *    不处理的话，两条线会在鞍点处交叉成 X —— 等深线上看起来像"打了个结"。
 *
 * @param {ArrayLike<number>} field 连续场，长度 ≥ cols*rows（下标 = r*cols+c）
 * @param {number} cols
 * @param {number} rows
 * @param {Array<[number,number]|{x:number,y:number}>} pts 格心世界坐标（行优先）
 * @param {number|number[]} levels 一个或多个等值
 * @returns {Array<{level:number, points:Array<{x:number,y:number}>}>} 折线（首尾不闭合也照给）
 */
export function extractIsoLines(field, cols, rows, pts, levels) {
  const c0 = cols | 0;
  const r0 = rows | 0;
  if (!field || !pts || c0 < 2 || r0 < 2) return [];
  if (field.length < c0 * r0 || pts.length < c0 * r0) return [];
  const wants = Array.isArray(levels) ? levels : [levels];
  const lvls = wants.map(Number).filter((v) => Number.isFinite(v));
  if (!lvls.length) return [];

  const coord = (c, r) => {
    const p = pts[r * c0 + c];
    return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
  };
  const P = new Array(c0 * r0);
  for (let r = 0; r < r0; r++) {
    for (let c = 0; c < c0; c++) P[r * c0 + c] = coord(c, r);
  }
  const V = (c, r) => field[r * c0 + c];

  const out = [];
  for (const level of lvls) {
    // ① 每个格子出线段（0 / 2 / 4 个交点）
    const segs = [];
    const lerp = (a, b, va, vb) => {
      const d = vb - va;
      const t = Math.abs(d) > 1e-12 ? (level - va) / d : 0.5;
      const k = t < 0 ? 0 : t > 1 ? 1 : t;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    };
    for (let r = 0; r + 1 < r0; r++) {
      for (let c = 0; c + 1 < c0; c++) {
        const i00 = r * c0 + c;
        const v00 = V(c, r), v10 = V(c + 1, r), v11 = V(c + 1, r + 1), v01 = V(c, r + 1);
        const a00 = v00 >= level, a10 = v10 >= level, a11 = v11 >= level, a01 = v01 >= level;
        const code = (a00 ? 1 : 0) | (a10 ? 2 : 0) | (a11 ? 4 : 0) | (a01 ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const p00 = P[i00], p10 = P[i00 + 1], p11 = P[i00 + c0 + 1], p01 = P[i00 + c0];
        const e = [];
        if (a00 !== a10) e[0] = lerp(p00, p10, v00, v10); else e[0] = null;   // 上
        if (a10 !== a11) e[1] = lerp(p10, p11, v10, v11); else e[1] = null;   // 右
        if (a11 !== a01) e[2] = lerp(p11, p01, v11, v01); else e[2] = null;   // 下
        if (a01 !== a00) e[3] = lerp(p01, p00, v01, v00); else e[3] = null;   // 左
        const hits = [0, 1, 2, 3].filter((k) => e[k]);
        if (hits.length === 2) {
          segs.push([e[hits[0]], e[hits[1]]]);
        } else if (hits.length === 4) {
          // 鞍点（对角两高两低）：按**中心均值**决定连法，否则两条线在格心交叉成 X。
          //   边号：0=上(00-10) 1=右(10-11) 2=下(11-01) 3=左(01-00)
          const center = (v00 + v10 + v11 + v01) / 4;
          const highCenter = center >= level;
          let pairs;
          if (code === 5) {
            // 对角 00 / 11 高：中心也高 → 两个低角（TR / BL）各自被围住
            pairs = highCenter ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
          } else {
            // code 10：对角 10 / 01 高
            pairs = highCenter ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
          }
          segs.push([e[pairs[0][0]], e[pairs[0][1]]]);
          segs.push([e[pairs[1][0]], e[pairs[1][1]]]);
        }
      }
    }
    if (!segs.length) continue;

    // ② 首尾相接成折线（同一格边上的交点由同一组输入算出 → 坐标逐位相同，直接按 key 拼）
    const key = (p) => p.x.toFixed(3) + ',' + p.y.toFixed(3);
    const keyPt = new Map();
    const adj = new Map();
    for (let s = 0; s < segs.length; s++) {
      for (const end of [0, 1]) {
        const p = segs[s][end];
        const k = key(p);
        keyPt.set(k, p);
        let arr = adj.get(k);
        if (!arr) { arr = []; adj.set(k, arr); }
        arr.push({ s, end });
      }
    }
    const used = new Uint8Array(segs.length);
    const trace = (startKey) => {
      const line = [keyPt.get(startKey)];
      let cur = startKey;
      for (;;) {
        const arr = adj.get(cur);
        if (!arr) break;
        let pick = null;
        for (const it of arr) {
          if (!used[it.s]) { pick = it; break; }
        }
        if (!pick) break;
        used[pick.s] = 1;
        const seg = segs[pick.s];
        // `pick.end` = 该段落在 cur 上的那一端 → 从另一端走出去
        const next = pick.end === 0 ? seg[1] : seg[0];
        line.push(next);
        cur = key(next);
      }
      return line;
    };
    // 先走开口端（度 = 1），再走闭环
    for (const [k, arr] of adj) {
      if (arr.length === 1 && !used[arr[0].s]) {
        const line = trace(k);
        if (line.length >= 2) out.push({ level, points: line });
      }
    }
    for (let s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      const line = trace(key(segs[s][0]));
      if (line.length >= 2) out.push({ level, points: line });
    }
  }
  return out;
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
