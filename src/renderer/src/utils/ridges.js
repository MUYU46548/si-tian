// utils/ridges.js — 从高度图抽**山脊候选**（纯函数；2026-10-26）
//
// ── 为什么需要它（用户参照的意大利地形图：山系名沿山脉走向排）──
// 我们的数据里只有高度图，没有任何"山脉"实体；而参考图的信息密度有一半来自
// 「亚平宁山脉 / 阿尔卑斯」这类**沿走向排布的山系名**。凭空生成专名是世界观决策
// （不能自动编），所以这里只做**候选脊线**：用户给名字，几何由地形决定。
//
// ── 算法（五步，全是格上的线性扫描）────────────────────────────────────────
//   ① 3×3 平滑（去掉单格噪声，否则脊线全是碎点）；
//   ② 山脊得分 = 自身高度 − 4 邻域均值（正 = 比周围高，山脊/山脊肩）；
//   ③ 阈值 = 陆地得分的分位数（默认 p82，**按本幅图分布**，不写死高度差）；
//   ④ 非极大抑制（8 邻域里不是最大就丢）→ 脊线变成一格宽的细线；
//   ⑤ 8 连通成组 → 组内**两次 BFS 求最长路径**（山脊主脊）→ 世界坐标 + 平滑。
//
// ⚠️ 只返回**候选**：`{ points, length, meanHeight, peakHeight, cells }`。
//    命名、筛选、落库都在调用方（`TerrainLabelsPanel` → store），本模块不碰 store / DOM。
//
// 纯函数：Node 可直接测（`scripts/tests/unit/test_ridges.js`）。

/**
 * Zhang-Suen 细化（二值骨架）—— 把"脊带"削成一格宽的线。
 *
 * @param {Uint8Array} bin 0/1 掩膜（不原地改）
 * @param {number} cols @param {number} rows
 * @returns {Uint8Array} 骨架（1 = 保留）
 */
function thinBinary(bin, cols, rows) {
  const img = new Uint8Array(bin);
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? 0 : img[y * cols + x];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const marks = [];
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          const i = y * cols + x;
          if (!img[i]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) {
            continue;
          }
          marks.push(i);
        }
      }
      if (marks.length) {
        changed = true;
        for (const i of marks) img[i] = 0;
      }
    }
  }
  return img;
}

/**
 * @param {object} hm 高度图 `{h, grid:{cellsX,cellsY,points,spacing}}`
 * @param {object} [opts]
 * @param {number} [opts.seaLevel=20]
 * @param {number} [opts.quantile=0.82] 脊线阈值分位（越高越少、越主干）
 * @param {number} [opts.minCells=6] 少于这么多格的脊线当噪声丢了
 * @param {number} [opts.maxRidges=12]
 * @param {(pts:Array)=>Array} [opts.smooth] 平滑函数（调用方传共享的 `smoothPolyline`）
 * @returns {Array<{points:Array<{x:number,y:number}>, length:number, meanHeight:number,
 *                  peakHeight:number, cells:number}>} 按长度降序
 */
export function detectRidges(hm, opts = {}) {
  const grid = hm && hm.grid;
  const h = hm && hm.h;
  if (!grid || !h || !h.length) return [];
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  const n = cols * rows;
  if (!(cols > 2) || !(rows > 2) || n > h.length) return [];
  const pts = grid.points;
  if (!pts || pts.length < n) return [];

  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const quantile = Number.isFinite(opts.quantile) ? Math.min(0.99, Math.max(0.5, opts.quantile)) : 0.82;
  const minCells = Number.isFinite(opts.minCells) ? Math.max(3, opts.minCells | 0) : 6;
  const maxRidges = Number.isFinite(opts.maxRidges) ? Math.max(1, opts.maxRidges | 0) : 12;
  const smooth = typeof opts.smooth === 'function' ? opts.smooth : null;

  // ① 平滑（3×3 盒，只对陆地；海格保持 seaLevel 以下，免得海岸被当成"脊"）
  const f = new Float32Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if ((h[i] || 0) < seaLevel) { f[i] = h[i] || 0; continue; }
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= cols) continue;
          const k = ny * cols + nx;
          if ((h[k] || 0) < seaLevel) continue;   // 海格不参与平均（海岸不是脊）
          sum += h[k];
          cnt++;
        }
      }
      f[i] = cnt ? sum / cnt : h[i];
    }
  }

  // ② 脊得分 = 自身 − 4 邻域均值
  const score = new Float32Array(n);
  const landScores = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if ((h[i] || 0) < seaLevel + 1) continue;
      let sum = 0;
      let cnt = 0;
      // ⚠️ 只平均**陆格**：把海格（高度低）算进来，贴岸那一行会凭空多出 3~4 的高度差 →
      //    整条海岸线都会被当成"山脊"（实测：对角山脊的候选变成了沿图框的一圈）。
      if (x > 0 && (h[i - 1] || 0) >= seaLevel) { sum += f[i - 1]; cnt++; }
      if (x < cols - 1 && (h[i + 1] || 0) >= seaLevel) { sum += f[i + 1]; cnt++; }
      if (y > 0 && (h[i - cols] || 0) >= seaLevel) { sum += f[i - cols]; cnt++; }
      if (y < rows - 1 && (h[i + cols] || 0) >= seaLevel) { sum += f[i + cols]; cnt++; }
      if (!cnt) continue;
      score[i] = f[i] - sum / cnt;
      landScores.push(score[i]);
    }
  }
  if (!landScores.length) return [];
  landScores.sort((a, b) => a - b);
  const qIdx = Math.min(landScores.length - 1, Math.floor(quantile * (landScores.length - 1)));
  const thr = Math.max(0.25, landScores[qIdx]);

  // ③ 二值化 + **细化（Zhang-Suen）**：脊带先取出来，再削成一格宽的骨架。
  // 🔴 为什么不用"非极大抑制"：平滑过的山脊是**宽脊**（几格都是局部最大），NMS 要么
  //    削不干净、要么因浮点并列把整条脊杀光（实测 48×48 的人造脊只剩 7 格）。细化算法
  //    对宽窄一视同仁，且不会因为数值并列丢整条。
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    bin[i] = (score[i] >= thr && (h[i] || 0) >= seaLevel + 1) ? 1 : 0;
  }
  const keep = thinBinary(bin, cols, rows);

  // ④ 连通组 + 组内最长路径（两次 BFS：脊线是一条链，不是一棵树）
  const worldOf = (i) => {
    const p = pts[i];
    return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
  };
  const visited = new Uint8Array(n);
  const neighbours = (i) => {
    const out = [];
    const x = i % cols;
    const y = (i / cols) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= cols) continue;
        const j = ny * cols + nx;
        if (keep[j]) out.push(j);
      }
    }
    return out;
  };

  const ridges = [];
  for (let start = 0; start < n; start++) {
    if (!keep[start] || visited[start]) continue;
    // 收集这一组
    const comp = [];
    const queue = [start];
    visited[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      comp.push(i);
      for (const j of neighbours(i)) {
        if (visited[j]) continue;
        visited[j] = 1;
        queue.push(j);
      }
    }
    if (comp.length < minCells) continue;

    // 两次 BFS 求直径（组内按 8 连通、边长=1；脊线是链，等权就够）
    const inComp = new Set(comp);
    const bfs = (from) => {
      const dist = new Map([[from, 0]]);
      const parent = new Map();
      const q = [from];
      let far = from;
      for (let head = 0; head < q.length; head++) {
        const i = q[head];
        const d = dist.get(i);
        if (d > dist.get(far)) far = i;
        for (const j of neighbours(i)) {
          if (!inComp.has(j) || dist.has(j)) continue;
          dist.set(j, d + 1);
          parent.set(j, i);
          q.push(j);
        }
      }
      return { far, parent };
    };
    const b1 = bfs(comp[0]);
    const b2 = bfs(b1.far);
    const path = [];
    let cur = b2.far;
    while (cur !== undefined && cur !== null) {
      path.push(cur);
      cur = b2.parent.get(cur);
    }
    if (path.length < minCells) continue;

    // ⑤ 世界坐标 + 平滑
    let points = path.map(worldOf);
    if (smooth) {
      try { points = smooth(points) || points; } catch (_) { /* 平滑失败就用原线，不整条丢 */ }
    }
    let length = 0;
    for (let k = 1; k < points.length; k++) {
      length += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
    }
    if (!(length > 0)) continue;
    let sumH = 0;
    let peak = -Infinity;
    for (const i of path) {
      const v = h[i] || 0;
      sumH += v;
      if (v > peak) peak = v;
    }
    ridges.push({
      points,
      length: Math.round(length * 100) / 100,
      meanHeight: Math.round((sumH / path.length) * 100) / 100,
      peakHeight: Math.round(peak * 100) / 100,
      cells: path.length,
    });
  }

  ridges.sort((a, b) => (b.length - a.length) || (b.peakHeight - a.peakHeight));
  return ridges.slice(0, maxRidges);
}
