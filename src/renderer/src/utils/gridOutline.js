/**
 * gridOutline.js — 把「标签网格」转成平滑闭合轮廓（纯函数，无 DOM 依赖 → 可进 Node 单测）
 *
 * 用途：地形涂色网格（terrainGrid，8 种地形）与生物群系高度图（heightmap.biome）
 * 这类「每格一个标签」的栅格数据 —— 逐格 fillRect/roundRect 渲染出来的就是马赛克方块。
 * 本模块把栅格边界抽成矢量闭合环 → 共线塌缩 → RDP 简化 → Chaikin 平滑，
 * 绘制端即可得到有机的、像手绘地形块的轮廓。
 *
 * 坐标：格 (c, r) 占据角点 (c,r) → (c+1,r+1) 的方格（r 向下为正）。
 * 输出环的坐标是**格单位**（角点整数坐标），由调用方乘 cell 并加原点转世界坐标。
 *
 * 🔴 两条实现纪律（都踩过）：
 *  ① 边界边的方向必须首尾相接成环，否则走链会散架。本模块用「左手侧 = 本格」统一取向：
 *     东 x=c+1 (c+1,r+1)→(c+1,r)   西 x=c   (c,r)  →(c,r+1)
 *     南 y=r+1 (c,r+1)  →(c+1,r+1) 北 y=r   (c+1,r)→(c,r)
 *     西边的起点是 (c, r) 而不是 (c+1, r)（写成 c+1 会丢掉最左一列格子的西边，
 *     环面积凭空少一列、带洞图形直接散架）。
 *  ② 邻接表用 CSR 扁平数组（计数 → 前缀和 → 填边），**不要用 Map<string|number, number[]>**：
 *     40k 格规模下 Map 版走链是 56ms，CSR 版个位数毫秒。
 */

const DIR = [
  // [邻格偏移 dc, dr, 起点角点 dc0, dr0, 终点角点 dc1, dr1]
  [1, 0, 1, 1, 1, 0],   // 东邻 → 东边，向上
  [-1, 0, 0, 0, 0, 1],  // 西邻 → 西边，向下
  [0, 1, 0, 1, 1, 1],   // 南邻 → 南边，向东
  [0, -1, 1, 0, 0, 0],  // 北邻 → 北边，向西
];

/**
 * 抽边界有向边 → 走链成环。
 * @param {ArrayLike<number>} labels 长度 = cols*rows 的标签网格
 * @param {number} cols
 * @param {number} rows
 * @param {{outside?:number, ignore?:ArrayLike<number>}} [opts]
 *        outside = 网格外框的虚拟标签（地形涂色传 255=未绘制；群系网格传 -1）
 *        ignore  = 不参与轮廓的标签值（地形涂色要忽略 255）
 * @returns {Map<number, Array<Array<[number, number]>>>} 标签 → 角点环数组
 */
export function traceLabelLoops(labels, cols, rows, opts = {}) {
  const outside = opts.outside === undefined ? -1 : opts.outside;
  const ignore = opts.ignore || null;
  const stride = rows + 1;
  const nodeCount = (cols + 1) * stride;
  const skip = (v) => v === outside || (ignore !== null && ignore.indexOf(v) >= 0);

  // ---- pass 1：统计每个角点的出边数 + 总边数 ----
  const deg = new Uint8Array(nodeCount);
  let edgeCount = 0;
  for (let r = 0; r < rows; r++) {
    const rowBase = r * cols;
    for (let c = 0; c < cols; c++) {
      const v = labels[rowBase + c];
      if (skip(v)) continue;
      for (let d = 0; d < 4; d++) {
        const o = DIR[d];
        const nc = c + o[0], nr = r + o[1];
        const nv = (nc < 0 || nc >= cols || nr < 0 || nr >= rows) ? outside : labels[nr * cols + nc];
        if (nv === v) continue;
        deg[(c + o[2]) * stride + (r + o[3])]++;
        edgeCount++;
      }
    }
  }
  if (!edgeCount) return new Map();

  // ---- 前缀和 → CSR 起点表 ----
  const start = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) start[i + 1] = start[i] + deg[i];
  const cursor = Int32Array.from(start.subarray(0, nodeCount));
  const snode = new Int32Array(edgeCount);
  const enode = new Int32Array(edgeCount);
  const labs = new Int32Array(edgeCount);
  const used = new Uint8Array(edgeCount);

  // ---- pass 2：填边（起点/终点角点都直接写入，走链时无需反查） ----
  for (let r = 0; r < rows; r++) {
    const rowBase = r * cols;
    for (let c = 0; c < cols; c++) {
      const v = labels[rowBase + c];
      if (skip(v)) continue;
      for (let d = 0; d < 4; d++) {
        const o = DIR[d];
        const nc = c + o[0], nr = r + o[1];
        const nv = (nc < 0 || nc >= cols || nr < 0 || nr >= rows) ? outside : labels[nr * cols + nc];
        if (nv === v) continue;
        const s = (c + o[2]) * stride + (r + o[3]);
        const k = cursor[s]++;
        snode[k] = s;
        enode[k] = (c + o[4]) * stride + (r + o[5]);
        labs[k] = v;
      }
    }
  }

  // ---- 走链：在每个终点角点找一条同标签的未用出边（同标签同角点最多 4 条 → O(1)） ----
  const byLabel = new Map();
  for (let n = 0; n < nodeCount; n++) {
    for (let e = start[n]; e < start[n + 1]; e++) {
      if (used[e]) continue;
      const label = labs[e];
      const firstNode = snode[e];
      const loop = [];
      let cur = e;
      let guard = 0;
      const cap = 4 * edgeCount + 16;
      while (guard++ < cap) {
        used[cur] = 1;
        loop.push([Math.floor(snode[cur] / stride), snode[cur] % stride]);
        const to = enode[cur];
        let next = -1;
        for (let f = start[to]; f < start[to + 1]; f++) {
          if (!used[f] && labs[f] === label) { next = f; break; }
        }
        if (next < 0) break;
        cur = next;
      }
      if (enode[cur] !== firstNode || loop.length < 4) continue; // 未闭合的碎链丢掉
      let bucket = byLabel.get(label);
      if (!bucket) { bucket = []; byLabel.set(label, bucket); }
      bucket.push(loop);
    }
  }
  return byLabel;
}

/** 去掉共线的中间点（阶梯边界会因此塌成斜线，点数通常降到 1/3 以下） */
export function collapseCollinear(loop) {
  const n = loop.length;
  if (n < 4) return loop.map(p => [p[0], p[1]]);
  const outLoop = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    const s1x = Math.sign(b[0] - a[0]), s1y = Math.sign(b[1] - a[1]);
    const s2x = Math.sign(c[0] - b[0]), s2y = Math.sign(c[1] - b[1]);
    if (s1x === s2x && s1y === s2y) continue; // 同向 = 共线，中间点可删
    outLoop.push([b[0], b[1]]);
  }
  return outLoop.length >= 3 ? outLoop : loop.map(p => [p[0], p[1]]);
}

/** 闭合环 RDP：以「离质心最远的点」为锚点破环，结果与起点无关（同 regionTrace 的手法） */
export function simplifyLoop(loop, eps) {
  const n = loop.length;
  if (n < 5 || eps <= 0) return loop.map(p => [p[0], p[1]]);
  let cx = 0, cy = 0;
  for (const p of loop) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let best = 0, bestD = -1;
  for (let i = 0; i < n; i++) {
    const d = (loop[i][0] - cx) ** 2 + (loop[i][1] - cy) ** 2;
    if (d > bestD) { bestD = d; best = i; }
  }
  const rot = loop.slice(best).concat(loop.slice(0, best));
  rot.push(rot[0]); // 闭合成开折线供 RDP 用

  const keep = new Uint8Array(rot.length);
  keep[0] = 1; keep[rot.length - 1] = 1;
  const stack = [[0, rot.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const ax = rot[s][0], ay = rot[s][1];
    const bx = rot[e][0], by = rot[e][1];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    let far = -1, farD = -1;
    for (let i = s + 1; i < e; i++) {
      const px = rot[i][0], py = rot[i][1];
      const d = len < 1e-9
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > farD) { farD = d; far = i; }
    }
    if (farD <= eps) continue;
    keep[far] = 1;
    stack.push([s, far], [far, e]);
  }
  const outLoop = [];
  for (let i = 0; i < rot.length - 1; i++) if (keep[i]) outLoop.push(rot[i]);
  return outLoop.length >= 3 ? outLoop : loop.map(p => [p[0], p[1]]);
}

/** Chaikin 圆角（闭合环版，0.75/0.25 取点）。直接 fill 原始格边是锯齿，观感立刻降级。 */
export function chaikinLoop(loop, iters = 2) {
  let pts = loop.map(p => [p[0], p[1]]);
  if (pts.length < 3) return pts;
  for (let it = 0; it < iters; it++) {
    const out = new Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out[i * 2] = [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25];
      out[i * 2 + 1] = [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75];
    }
    pts = out;
  }
  return pts;
}

/** 鞋带公式：环的面积绝对值（格²）—— 用于丢弃退化环 */
export function loopArea(loop) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/**
 * 一站式：标签网格 → 每个标签的平滑闭合环（世界坐标）。
 * @param {ArrayLike<number>} labels
 * @param {number} cols
 * @param {number} rows
 * @param {{cell:number, ox:number, oy:number, eps?:number, chaikinIters?:number,
 *          outside?:number, ignore?:ArrayLike<number>, minAreaCells?:number}} opts
 *        eps / minAreaCells 以**格**为单位（不是世界单位：格宽会变，固定世界单位阈值会失效）
 * @returns {Map<number, Array<{pts:Array<{x:number,y:number}>, bbox:number[]}>>}
 */
export function buildLabelOutlines(labels, cols, rows, opts) {
  const {
    cell, ox, oy,
    eps = 0.75, chaikinIters = 2,
    outside = -1, ignore = null,
    minAreaCells = 0.5,
  } = opts;
  const loops = traceLabelLoops(labels, cols, rows, { outside, ignore });
  const result = new Map();
  for (const [label, list] of loops) {
    const kept = [];
    for (const raw of list) {
      let s = collapseCollinear(raw);
      s = simplifyLoop(s, eps);
      if (loopArea(s) < minAreaCells) continue;
      const smooth = chaikinLoop(s, chaikinIters);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const pts = smooth.map(([c, r]) => {
        const x = ox + c * cell, y = oy + r * cell;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        return { x, y };
      });
      kept.push({ pts, bbox: [minX, minY, maxX, maxY] });
    }
    if (kept.length) result.set(label, kept);
  }
  return result;
}
