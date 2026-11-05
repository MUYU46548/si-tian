// utils/drainageBasins.js — **排水盆地骨架**：给水几个“真正的出口”，让它有谷可汇
// （P2 实验模块，2026-11-04；默认关，见 `terrainSynthesis` 的 `drainageBasins` 选项）
//
// ── 为什么需要它（P2-A 第一轮实测的结论，别重走）──────────────────────────────
//   先试了纯坡面侵蚀（`terrainErosion.erodeGridSurface`，30 轮）：扇状度 0.852 → **0.884**
//   （更平行了），分叉 76 → 80，入海口 500 → 626。原因很清楚：
//   **D8 下切只会把“已经存在的流向”刻得更深**，不会自己发明一条新谷。
//   而 `terrainSynthesis` 的地形是一座**圆顶**：每个海岸格都是出水口，
//   水沿径向各自入海 —— 500 个出口，谁也不必汇给谁，于是永远是平行短棍。
//
//   所以顺序必须是：**先给水少数几个出口（骨架），再用侵蚀把谷刻细（皮肉）**。
//
// ── 做法 ───────────────────────────────────────────────────────────────────
//   ① 在**海岸线**上按“最远点采样”挑 K 个出水口（每个陆块至少 1 个；
//      大块按面积多分几个）—— 出水口之间尽量远离，才拉得出长河；
//   ② 从每个出水口出发，在**陆地上**做 chamfer 距离场（3-4 距离，与
//      `terrainSynthesis` 的离岸距离同一套近似欧氏口径）；每格取“到最近出水口的距离”
//      → 这张场在盆地**交界处最高**，天然就是分水岭；
//   ③ 每格归属到最近的出水口（`basinOf`）→ 水只会往自己的出口走，不会再从任意海岸漏掉。
//
//   距离场是**纯几何**：没有随机量（最远点采样的起点由格号最小者决定），
//   同一份陆地掩膜 + 同一个 K → 逐字节同一份结果。
//
// ⚠️ 只读：不改入参 `land`；返回新数组。

/** 版本标记（实验报告要写清是哪一版） */
export const DRAINAGE_BASINS_VERSION = 1;

/**
 * 找海岸格（陆格，且 8 邻里有海格或在网格边界上）。
 * @param {Uint8Array|Array<number>} land
 * @returns {Int32Array}
 */
function coastCells(land, cols, rows) {
  const out = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (!land[idx]) continue;
      let coast = i === 0 || j === 0 || i === cols - 1 || j === rows - 1;
      if (!coast) {
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          if (!land[(j + dy) * cols + (i + dx)]) { coast = true; break; }
        }
      }
      if (coast) out.push(idx);
    }
  }
  return Int32Array.from(out);
}

/** 陆块连通分量（8 邻域）；返回每格的组件号（海 = -1）与各组件格数 */
function components(land, cols, rows) {
  const n = cols * rows;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!land[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const ci = cur % cols, cj = (cur - ci) / cols;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const k = nj * cols + ni;
          if (land[k] && comp[k] < 0) { comp[k] = id; stack.push(k); }
        }
      }
    }
    sizes.push(size);
  }
  return { comp, sizes };
}

/**
 * chamfer 距离场（以格为单位，8 邻域，横竖 1、斜 √2）：只穿过陆格。
 * 与 `terrainSynthesis` 的离岸距离同口径（近似欧氏），等距线不是菱形。
 */
function chamferFrom(seeds, land, cols, rows) {
  const n = cols * rows;
  const INF = 1e18;
  const d = new Float64Array(n).fill(INF);
  for (const s of seeds) d[s] = 0;
  const A = 1, B = Math.SQRT2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (!land[idx]) continue;
      let v = d[idx];
      if (i > 0) v = Math.min(v, d[idx - 1] + A);
      if (j > 0) v = Math.min(v, d[idx - cols] + A);
      if (i > 0 && j > 0) v = Math.min(v, d[idx - cols - 1] + B);
      if (i < cols - 1 && j > 0) v = Math.min(v, d[idx - cols + 1] + B);
      d[idx] = v;
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const idx = j * cols + i;
      if (!land[idx]) continue;
      let v = d[idx];
      if (i < cols - 1) v = Math.min(v, d[idx + 1] + A);
      if (j < rows - 1) v = Math.min(v, d[idx + cols] + A);
      if (i < cols - 1 && j < rows - 1) v = Math.min(v, d[idx + cols + 1] + B);
      if (i > 0 && j < rows - 1) v = Math.min(v, d[idx + cols - 1] + B);
      d[idx] = v;
    }
  }
  return d;
}

/** 最远点采样：在候选点里挑 K 个互相尽量远的（欧氏，世界坐标） */
function farthestSample(cands, k, px, py) {
  if (!cands.length || k <= 0) return [];
  const picked = [cands[0]];
  const best = new Float64Array(cands.length).fill(Infinity);
  while (picked.length < Math.min(k, cands.length)) {
    const last = picked[picked.length - 1];
    const lx = px(last), ly = py(last);
    let bestIdx = -1, bestD = -1;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const dx = px(c) - lx, dy = py(c) - ly;
      const dd = dx * dx + dy * dy;
      if (dd < best[i]) best[i] = dd;
      if (best[i] > bestD) { bestD = best[i]; bestIdx = i; }
    }
    if (bestIdx < 0 || bestD <= 0) break;
    picked.push(cands[bestIdx]);
  }
  return picked;
}

/**
 * 建排水盆地骨架。
 *
 * @param {Uint8Array|Array<number>} land 陆地掩膜（1 = 陆）
 * @param {number} cols
 * @param {number} rows
 * @param {{outlets?:number, px?:Float64Array|Array<number>, py?:Float64Array|Array<number>}} [opts]
 *   `outlets` —— 目标出水口总数（默认 8）；按陆块面积分配：每块至少 1 个，
 *                大块按 `sqrt(面积)` 份额多分。
 *   `px/py`  —— 格心世界坐标（做“最远点采样”用；不传就退化成按格号距离，仍确定）。
 * @returns {{basinOf:Int32Array, dist:Float64Array, trunkDist:Float64Array, trunkMax:number,
 *            trunkCells:number, outlets:number[], count:number, maxDist:number,
 *            components:number, version:number}}
 *   `dist` = 每格到**最近出水口**的 chamfer 距离（格；海格为 0）；
 *   `trunkDist` = 每格到**本盆地主干谷线**的 chamfer 距离（2026-11-04 新增，海拔的主导演变量）；
 *   `basinOf` = 该格的最近出水口干编号（-1 = 海里没有归属）。
 */
export function buildDrainageBasins(land, cols, rows, opts = {}) {
  const n = cols * rows;
  const out = {
    basinOf: new Int32Array(n).fill(-1), dist: new Float64Array(n),
    // 主干谷（2026-11-04）：到“本盆地主干谷线”的距离 —— 海拔主要按它抬升，支流才会斜着汇入
    trunkDist: new Float64Array(n), trunkMax: 0, trunkCells: 0,
    outlets: [], count: 0, maxDist: 0, components: 0, version: DRAINAGE_BASINS_VERSION,
  };
  if (!(cols > 2 && rows > 2) || !land || land.length !== n) return out;
  const target = Math.max(1, Math.floor(Number(opts.outlets) || 8));
  const px = typeof opts.px === 'function' ? opts.px : (i) => i % cols;
  const py = typeof opts.py === 'function' ? opts.py : (i) => (i / cols) | 0;

  const { comp, sizes } = components(land, cols, rows);
  out.components = sizes.length;
  if (!sizes.length) return out;
  const coast = coastCells(land, cols, rows);
  if (!coast.length) return out;

  // ── 按陆块分配出水口数：每块 1 个起，其余按 sqrt(面积) 分 ──────────────────
  const byComp = new Map();
  for (const c of coast) {
    const id = comp[c];
    if (!byComp.has(id)) byComp.set(id, []);
    byComp.get(id).push(c);
  }
  const weights = sizes.map((s, i) => (byComp.has(i) ? Math.sqrt(s) : 0));
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const quota = sizes.map((s, i) => (byComp.has(i) ? Math.max(1, Math.round((target * weights[i]) / wSum)) : 0));

  const seeds = [];
  for (const [id, list] of byComp) {
    const k = quota[id] || 1;
    // 候选按格号升序（确定性）：最远点采样的起点 = 该块格号最小的海岸格
    const cands = list.slice().sort((a, b) => a - b);
    for (const s of farthestSample(cands, k, px, py)) seeds.push(s);
  }
  if (!seeds.length) return out;
  out.outlets = seeds.slice();
  out.count = seeds.length;

  // ── 每个出水口一张距离场 → 逐格取最近 ─────────────────────────────────────
  let best = new Float64Array(n).fill(Infinity);
  const fields = [];
  for (let o = 0; o < seeds.length; o++) {
    const d = chamferFrom([seeds[o]], land, cols, rows);
    fields.push(d);
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      if (d[i] < best[i]) { best[i] = d[i]; out.basinOf[i] = o; }
    }
  }
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i]) { out.dist[i] = 0; continue; }
    const v = Number.isFinite(best[i]) ? best[i] : 0;
    out.dist[i] = v;
    if (v > maxDist) maxDist = v;
  }
  // 陆块与所有出水口都不连通（被海隔断的碎片）→ 距离 0，别让它变成高台
  for (let i = 0; i < n; i++) if (land[i] && !Number.isFinite(best[i])) { best[i] = 0; out.dist[i] = 0; }
  out.maxDist = maxDist;

  // ── 主干谷骨架：每个盆地一条“出口 → 最远内陆点”的测地线，再取到它的距离 ─────────
  //   为什么还要这一层（2026-11-04 实测）：只按“到出口的距离”抬升，盆地内部仍是一个光滑的
  //   径向扇 —— 水朝出口汇，但支流之间依然平行（扇状度反而 0.852 → 0.901）。
  //   谷是**线**：先画出主干线，让海拔随“到主干谷的距离”下降，支流才会从两侧**斜着**汇进来。
  const trunkSeeds = [];
  for (let o = 0; o < seeds.length; o++) {
    const d = fields[o];
    let far = -1, farD = -1;
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      if (out.basinOf[i] !== o) continue;         // 只在本盆地里找
      if (Number.isFinite(d[i]) && d[i] > farD) { farD = d[i]; far = i; }
    }
    if (far < 0) continue;
    // 沿“距离严格下降”的邻格走回出口 = 该盆地的测地线（确定性：同距取格号最小者）
    let cur = far, guard = 0;
    while (cur >= 0 && guard++ < n) {
      trunkSeeds.push(cur);
      const cd = d[cur];
      if (!(cd > 0)) break;
      const ci = cur % cols, cj = (cur - ci) / cols;
      let next = -1, nextD = cd;
      for (let j2 = -1; j2 <= 1; j2++) {
        for (let i2 = -1; i2 <= 1; i2++) {
          if (!i2 && !j2) continue;
          const ni = ci + i2, nj = cj + j2;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const k = nj * cols + ni;
          if (!land[k] || out.basinOf[k] !== o) continue;
          if (d[k] < nextD) { nextD = d[k]; next = k; }
        }
      }
      if (next < 0) break;
      cur = next;
    }
  }
  out.trunkDist = trunkSeeds.length ? chamferFrom(trunkSeeds, land, cols, rows) : new Float64Array(n);
  let trunkMax = 0;
  for (let i = 0; i < n; i++) if (land[i] && out.trunkDist[i] > trunkMax) trunkMax = out.trunkDist[i];
  out.trunkMax = trunkMax;
  out.trunkCells = trunkSeeds.length;
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// P2.1（2026-11-04）：**递归分级河网骨架** —— 支流挂到干流上
// ══════════════════════════════════════════════════════════════════════════════
//
// 为什么单层盆地不够（实测）：只按“到出口的距离”抬升时，盆地内部是光滑径向扇，
// 扇状度反而 0.900（更平行）；加一条主干谷线后最长路径通了（737），但支流仍是
// 一条条**垂直于干谷**的平行短线（扇状度 0.827）。真实河网是**分级**的：
// 小沟汇进支流、支流斜着汇进干流，每一级都有自己的方向 —— 8 格窗口里才会出现
// 不同向的线段。所以这里把“盆地 + 主干”递归下去：每个区域里画一条主河道，
// 再沿主河道挂几个子出口，子区域各自再画主河道……直到区域足够小。
//
// 产出不是一个高度场，而是**势场 p**：每格 “沿水面到出口的距离”。
//   · 河道格：p = 沿河道到出口的累计距离（支流从它汇入干流的那一格开始累加）；
//   · 山坡格：p = 到最近河道的距离 + 该河道格的 p（Dijkstra 传播）。
// p 单调向出口减小 ⇒ 把它当海拔（单调变换后），水就沿这张骨架流：
// 支流 → 干流 → 出口。这是“先画谷，再抬山”，与卡上的 B 路是同一件事。

/** 二叉最小堆（Dijkstra 用；只存 cost + 格号） */
function makeMinHeap() {
  const keys = [];
  const vals = [];
  return {
    push(k, v) {
      keys.push(k); vals.push(v);
      let i = keys.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= keys[i]) break;
        [keys[p], keys[i]] = [keys[i], keys[p]];
        [vals[p], vals[i]] = [vals[i], vals[p]];
        i = p;
      }
    },
    pop() {
      const topK = keys[0], topV = vals[0];
      const lastK = keys.pop(), lastV = vals.pop();
      if (keys.length) {
        keys[0] = lastK; vals[0] = lastV;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < keys.length && keys[l] < keys[m]) m = l;
          if (r < keys.length && keys[r] < keys[m]) m = r;
          if (m === i) break;
          [keys[m], keys[i]] = [keys[i], keys[m]];
          [vals[m], vals[i]] = [vals[i], vals[m]];
          i = m;
        }
      }
      return [topK, topV];
    },
    get size() { return keys.length; },
  };
}

/** 只在 `mask` 内传播的 chamfer 距离场（区域受限；与全局版同口径） */
function chamferMasked(seeds, mask, cols, rows) {
  const n = cols * rows;
  const INF = 1e18;
  const d = new Float64Array(n).fill(INF);
  for (const s of seeds) d[s] = 0;
  const A = 1, B = Math.SQRT2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (!mask[idx]) continue;
      let v = d[idx];
      if (i > 0) v = Math.min(v, d[idx - 1] + A);
      if (j > 0) v = Math.min(v, d[idx - cols] + A);
      if (i > 0 && j > 0) v = Math.min(v, d[idx - cols - 1] + B);
      if (i < cols - 1 && j > 0) v = Math.min(v, d[idx - cols + 1] + B);
      d[idx] = v;
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const idx = j * cols + i;
      if (!mask[idx]) continue;
      let v = d[idx];
      if (i < cols - 1) v = Math.min(v, d[idx + 1] + A);
      if (j < rows - 1) v = Math.min(v, d[idx + cols] + A);
      if (i < cols - 1 && j < rows - 1) v = Math.min(v, d[idx + cols + 1] + B);
      if (i > 0 && j < rows - 1) v = Math.min(v, d[idx + cols - 1] + B);
      d[idx] = v;
    }
  }
  return d;
}

/**
 * 递归分级河网骨架。
 *
 * @param {Uint8Array|Array<number>} land 陆地掩膜（1 = 陆）
 * @param {number} cols
 * @param {number} rows
 * @param {{outlets?:number, depth?:number, branching?:number, minCells?:number}} [opts]
 *   `outlets` 河口数（默认 8）· `depth` 递归层数（默认 3）· `branching` 每层挂几条支流（默认 2）
 *   `minCells` 区域小于它就不再细分（默认 260）
 * @returns {{p:Float64Array, maxP:number, streamCells:number, channels:number, maxPathLen:number,
 *            outlets:number[], depth:number, version:number}}
 *   `p[i]` = 沿水面到出口的距离（海格为 0；没有骨架时为 Infinity）；
 *   把它单调映射成海拔，水就会沿骨架从支流汇进干流。
 */
export function buildDrainageTree(land, cols, rows, opts = {}) {
  const n = cols * rows;
  const out = {
    p: new Float64Array(n).fill(Infinity), maxP: 0, streamCells: 0, channels: 0,
    maxPathLen: 0, outlets: [], depth: 1, version: DRAINAGE_BASINS_VERSION,
  };
  if (!(cols > 2 && rows > 2) || !land || land.length !== n) return out;
  const outlets = Math.max(1, Math.floor(Number(opts.outlets) || 8));
  const maxDepth = Math.max(1, Math.min(6, Math.floor(Number(opts.depth) || 3)));
  const branching = Math.max(1, Math.min(4, Math.floor(Number(opts.branching) || 2)));
  const minCells = Math.max(60, Math.floor(Number(opts.minCells) || 260));
  out.depth = maxDepth;

  const B = buildDrainageBasins(land, cols, rows, { outlets });
  out.outlets = B.outlets.slice();
  if (!B.count) return out;

  const p = new Float64Array(n).fill(Infinity);
  const isStream = new Uint8Array(n);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const o = B.basinOf[i];
    if (o < 0) continue;
    if (!groups.has(o)) groups.set(o, []);
    groups.get(o).push(i);
  }
  const stack = [];
  for (const [o, cells] of groups) {
    stack.push({ cells, mouth: B.outlets[o], mouthP: 0, depth: 0 });
  }

  while (stack.length) {
    const task = stack.pop();
    const { cells, mouth, mouthP, depth } = task;
    const mask = new Uint8Array(n);
    for (const c of cells) mask[c] = 1;
    mask[mouth] = 1;
    const d = chamferMasked([mouth], mask, cols, rows);
    // 区域里离出口最远的一格 = 河道源头
    let far = -1, farD = -1;
    for (const c of cells) {
      if (Number.isFinite(d[c]) && d[c] > farD) { farD = d[c]; far = c; }
    }
    if (far < 0) { p[mouth] = Math.min(p[mouth], mouthP); isStream[mouth] = 1; continue; }
    // 源头 → 出口：沿距离严格下降走
    const path = [];
    let cur = far, guard = 0;
    while (cur >= 0 && guard++ < n) {
      path.push(cur);
      if (cur === mouth) break;
      const cd = d[cur];
      const ci = cur % cols, cj = (cur - ci) / cols;
      let next = -1, best = cd;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const k = nj * cols + ni;
          if (!mask[k]) continue;
          if (d[k] < best) { best = d[k]; next = k; }
        }
      }
      if (next < 0) break;
      cur = next;
    }
    const L = path.length;
    out.channels++;
    if (L > out.maxPathLen) out.maxPathLen = L;
    // 出口格必须先落成河道：测地线有时走不到出口（区域被切碎时），不兜底的话
    // “河口”会被 Dijkstra 当成山坡格（实测 p≈0.96），后续海拔就在海口翘起来。
    if (mouthP < p[mouth]) p[mouth] = mouthP;
    isStream[mouth] = 1;
    // path[0] = 源头 … path[L-1] = 出口：p 从出口往源头累加
    for (let k = 0; k < L; k++) {
      const cell = path[L - 1 - k];
      const val = mouthP + k;
      if (val < p[cell]) p[cell] = val;
      isStream[cell] = 1;
    }
    if (depth + 1 >= maxDepth || cells.length < minCells || L < 4) continue;
    // 沿主河道挂子出口（越靠源头分的支流越上游）
    const subs = [];
    for (let b = 1; b <= branching; b++) {
      const idx = Math.min(L - 2, Math.max(1, Math.round((L * b) / (branching + 1))));
      const cell = path[idx];
      if (!subs.includes(cell)) subs.push(cell);
    }
    if (!subs.length) continue;
    const fields = subs.map((s) => chamferMasked([s], mask, cols, rows));
    const buckets = subs.map(() => []);
    for (const c of cells) {
      let bi = -1, bd = Infinity;
      for (let s = 0; s < subs.length; s++) {
        const dd = fields[s][c];
        if (dd < bd) { bd = dd; bi = s; }
      }
      if (bi >= 0) buckets[bi].push(c);
    }
    for (let s = 0; s < subs.length; s++) {
      if (buckets[s].length < 24) continue;
      stack.push({ cells: buckets[s], mouth: subs[s], mouthP: Number(p[subs[s]]) || 0, depth: depth + 1 });
    }
  }

  // 山坡格：从所有河道格出发做 Dijkstra（代价 = 河道格的 p + 到它的距离）
  const heap = makeMinHeap();
  let streamCount = 0;
  for (let i = 0; i < n; i++) {
    if (!isStream[i]) { p[i] = Infinity; continue; }
    streamCount++;
    p[i] = Math.max(0, Math.min(1e9, p[i]));
    heap.push(p[i], i);
  }
  out.streamCells = streamCount;
  const A = 1, Bv = Math.SQRT2;
  while (heap.size) {
    const [cost, i] = heap.pop();
    if (cost > p[i] + 1e-9) continue;
    const ci = i % cols, cj = (i - ci) / cols;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const k = nj * cols + ni;
        if (!land[k]) continue;
        const nc = cost + (di && dj ? Bv : A);
        if (nc < p[k]) { p[k] = nc; heap.push(nc, k); }
      }
    }
  }
  let maxP = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i]) { p[i] = 0; continue; }
    if (!Number.isFinite(p[i])) p[i] = 0;
    if (p[i] > maxP) maxP = p[i];
  }

  // ── 低通：chamfer 距离场的等值线是**八边形**，直接抬成海拔会出现一格一格的台阶。
  //    在势场上做几遍 3×3 加权平滑（河道格权重更高，谷底不会被抹平）——
  //    代价是势场不再严格单调，但下游的填洼会把这点误差收干净。
  const passes = Math.max(0, Math.min(4, Math.floor(Number(opts.smooth) || 2)));
  if (passes > 0 && maxP > 0) {
    const w = [[1, 2, 1], [2, 4, 2], [1, 2, 1]];
    const src = new Float64Array(p);
    for (let pass = 0; pass < passes; pass++) {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          if (!land[idx]) { p[idx] = 0; continue; }
          let sum = 0, norm = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ni = i + di, nj = j + dj;
              if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
              const k = nj * cols + ni;
              if (!land[k]) continue;
              // 河道格压住权重：谷底（p 小）负责排水，不许被山坡拉高
              const ww = w[dj + 1][di + 1] * (isStream[k] ? 1.6 : 1);
              sum += src[k] * ww;
              norm += ww;
            }
          }
          p[idx] = norm > 0 ? sum / norm : src[idx];
        }
      }
      src.set(p);
    }
    maxP = 0;
    for (let i = 0; i < n; i++) if (land[i] && p[i] > maxP) maxP = p[i];
  }
  // 河口钉回 0：低通会把它抬高一点，而“海口必须在海平面上”是地形/水系的硬约束
  for (const o of out.outlets) if (land[o]) p[o] = 0;
  out.p = p;
  out.maxP = maxP;
  return out;
}