// utils/terrainErosion.js — **河成侵蚀层**：stream-power 下切 + 谷壁拓宽 + 坡面松弛（纯函数，Node 可测）
//
// ── 为什么需要它（2026-10-25/26 实测结论，别重走）──────────────────────────────
//   造陆 v4 把地形换成 `terrainSynthesis` 之后，直接把 `traceRivers` 接上去，画出来是
//   **整片 45° 平行直线 + 半山腰断头**（`docs/assets/landmass-v4-20261025/rivers-rejected.png`）。
//   根因不是"追踪算法坏了"，而是**地形没有谷**：
//     · 合成地形的主体是"离岸距离场"（一个圆丘）→ 坡面均匀 → 水只能**平行**下流；
//     · 洼地填平会把一片格子抬到**同一个水位**（溢流点），等高格上 `traceRivers` 的兜底
//       是按格号走（+x/+y），于是出现**成片的对角线**。
//   真实地形的谷是**水自己切出来的**：流量大的地方切得深，切得深的地方吸来更多水
//   （正反馈），最后收敛成树枝状水系。本模块就是这条正反馈的最小实现。
//
// ── 做法（每一轮）──────────────────────────────────────────────────────────────
//   ① **复用 `traceRivers` 的流向场**（不写第二套 D8）：它输出的 `segments` 是
//      "每格 → 它的下游格"，逐段带 `flow`（汇流格数）与 `cell`（格号）；
//   ② 对每一段按**河流功率**下切：`Δh = k · A^0.45 · S^0.9`（A = 流量，S = 到下游的坡度），
//      并**按局部落差封顶**（最多切掉落差的 55%）：不封顶会切出比下游还低的坑，
//      下一轮水就流不出去（`traceRivers` 会把它当内流盆地整片丢掉）；
//   ③ 重复 N 轮：上一轮切出来的浅沟会捕获更多汇流 → 下一轮切得更深 → 树枝状水系。
//
//   ⚠️ 只改 `hm.h`（就地），不碰 `grid`、不写盘；`traceRivers` 的 `H` 是内部拷贝，
//      所以"算流向"与"改高度"之间没有隐藏耦合。
//   ⚠️ 确定性：没有随机量（`traceRivers` 内部也只用确定性排序）。
//
// ══════════════════════════════════════════════════════════════════════════════
// N3b-1（2026-11-02）：从"切一条槽"升级到"切出会读成侵蚀的坡面"
// ══════════════════════════════════════════════════════════════════════════════
//   旧版只有 `inciseByFlow`：河床被切下去，**两侧邻居纹丝不动** —— 放大看是一条 1 格宽的
//   缝，坡面上看不到任何"被水侵蚀过"的细节（判据 N3b-1：海岸/坡面要有侵蚀感）。补三件事：
//     ① `widenValleys`：沿**排水网络**把河床两侧按 V 字剖面向下带（流量越大谷越宽、越深）。
//        谷壁永远高于床面 `VALLEY_BED_MARGIN`，所以"水往床里流"的方向不变；
//     ② `relaxSlopes`：**只削峰**的坡度阈值松弛（坡度低于阈值 → 一格都不动）。
//        平地（微起伏小于阈值）不会被抹成糊；山脊被磨圆。河床格有硬下限
//        （不低于下游 + `RIVER_DESCENT_EPS`）—— 这是"断头河"守卫的第一道；
//     ③ `countBrokenRivers` / `enforceRiverDescent`：**后置断言 + 兜底修复**。
//        判据是"河格不得低于它的下游格"（低于 = 断头/反坡坑），返回诊断计数。
//        `erodeTerrain` 跑完必须为 0；非 0 就是回归，用例（`test_terrain_erosion.js`）会红。
//
//   ⚠️ 三条不变量（改本文件时必须保住）：
//     · 海平面不变：任何下切都不低于 `seaLevel + 0.2`（海岸线/陆地占比是别处算好的）；
//     · 河格不反坡：河床格只许被"抬高修复"，绝不因削峰/拓谷降到下游以下；
//     · 同输入同输出：没有 `Math.random`，所有顺序都是确定性的（邻居表按点序排序）。

import { traceRivers } from './riverTrace';
import { buildGridIndexWithCellSize, pointXY } from './gridSpatialIndex';

/** 默认强度（每一轮的最大下切量，高度点） */
export const INCISE_STRENGTH = 2.2;
/** 每轮最多切掉"本格到下游落差"的比例（防止切出反坡坑） */
export const INCISE_MAX_DROP_FRAC = 0.55;
/** 流量指数（汇流面积的影响） */
export const INCISE_FLOW_EXP = 0.45;
/** 坡度指数 */
export const INCISE_SLOPE_EXP = 0.9;

/** 坡面松弛：坡度阈值（高度点 / 格）。低于它 → 视为平地，不松弛 */
export const TALUS_SLOPE_THRESHOLD = 1.4;
/** 坡面松弛：每轮把"高出邻居均值"的那部分削掉多少（0.35 = 三分之一） */
export const TALUS_RATE = 0.35;
/** 坡面松弛：阈值 → 阈值×该倍数 之间做平滑门（不是硬开关，避免出现一圈边界） */
export const TALUS_GATE_SPAN = 2.4;
/** 谷壁拓宽：河道两侧各几"跳"格（1 = 只有紧邻一圈） */
export const VALLEY_WALL_RADIUS = 2;
/** 谷壁拓宽：谷壁最大下切量 = 床面累计下切量 × 该比例 */
export const VALLEY_WALL_FRAC = 0.55;
/** 谷壁必须比床面高这么多（高度点）—— 低于它就不是"谷壁"而是第二个床 */
export const VALLEY_BED_MARGIN = 0.05;
/** 河床相对下游至少要有这么多落差（高度点）；断头河判据与兜底修复共用 */
export const RIVER_DESCENT_EPS = 0.01;

const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
const round2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 平滑分段（门）：`x <= e0` → 0，`x >= e1` → 1 */
function smoothstep01(e0, e1, x) {
  const d = e1 - e0;
  if (!(d > 0)) return x >= e1 ? 1 : 0;
  const t = clamp((x - e0) / d, 0, 1);
  return t * t * (3 - 2 * t);
}

/** 坐标量化键（与 `inciseByFlow` 的段端点反查同口径） */
function keyOf(x, y) {
  return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

/** 格号 → 世界坐标 的反查表（不假设网格是规则方阵：规则性只在自己合成时成立） */
function buildPosIndex(hm) {
  const n = hm.h.length;
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const p = hm.grid.points[i];
    const x = Array.isArray(p) ? p[0] : p && p.x;
    const y = Array.isArray(p) ? p[1] : p && p.y;
    if (Number.isFinite(x) && Number.isFinite(y)) map.set(keyOf(x, y), i);
  }
  return map;
}

/**
 * 把 `traceRivers` 的段解析成"起点格号 / 终点格号 / 流量"三列（跳过坏段）。
 * @returns {{count:number, a:Int32Array, b:Int32Array, flow:Float64Array}}
 */
function parseSegments(hm, segments) {
  const n = hm.h.length;
  const posIndex = buildPosIndex(hm);
  const a = [];
  const b = [];
  const flow = [];
  for (const s of segments) {
    const ia = Number.isFinite(s.cell) ? s.cell : posIndex.get(keyOf(s.x0, s.y0));
    if (!Number.isInteger(ia) || ia < 0 || ia >= n) continue;
    const ib = posIndex.get(keyOf(s.x1, s.y1));
    if (!Number.isInteger(ib) || ib < 0 || ib >= n || ib === ia) continue;
    a.push(ia);
    b.push(ib);
    flow.push(Number.isFinite(s.flow) ? s.flow : 1);
  }
  return { count: a.length, a: Int32Array.from(a), b: Int32Array.from(b), flow: Float64Array.from(flow) };
}

/**
 * "每格的下游格"表（下游未知 = -1）。
 * 谷壁拓宽与坡面松弛都用它做**河床下限**：`h[c] > h[down[c]] + RIVER_DESCENT_EPS`。
 */
function buildDownstream(segs, n) {
  const down = new Int32Array(n).fill(-1);
  for (let k = 0; k < segs.count; k++) {
    const a = segs.a[k];
    if (down[a] < 0) down[a] = segs.b[k];   // 每格只有一个 receiver，取第一条即可
  }
  return down;
}

/**
 * 建**邻居表**（CSR：`start[i] .. start[i+1]` 是 i 的邻居下标）。
 *
 * 为什么不用"上下左右 +4"的索引算术：高度图有两种来源 —— 造陆是规则方阵，
 * FMG 管线是**抖动/ Voronoi 点**（`fmg/lattice.placePoints`，点序与行列不对应）。
 * 用"半径 = 格距 × 1.5 的桶查询"这一套（与 `traceRivers` 找邻居同口径）对两者都成立，
 * 规则网格上它正好给出 8 邻居，抖动网格上给出真实的相邻点。
 *
 * @param {{h:number[], grid:{points:Array, spacing?:number}}} hm
 * @param {{factor?:number}} [opts]
 * @returns {{count:number, start:Int32Array|null, adj:Int32Array|null, spacing:number}}
 */
export function buildNeighborhood(hm, opts = {}) {
  const out = { count: 0, start: null, adj: null, spacing: 14.4 };
  if (!hm || !hm.grid || !Array.isArray(hm.grid.points) || !hm.grid.points.length) return out;
  const n = hm.grid.points.length;
  const spacing = Number(hm.grid.spacing) > 0 ? Number(hm.grid.spacing) : 14.4;
  const factor = Number.isFinite(opts.factor) ? Math.max(1, opts.factor) : 1.5;
  const radius = spacing * factor;
  const index = buildGridIndexWithCellSize(hm.grid, Math.max(radius, spacing));
  if (!index) return out;
  const { cellSize, minX, minY, cellMap } = index;
  const span = Math.ceil(radius / cellSize);
  const r2 = radius * radius;
  const lists = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [px, py] = pointXY(hm.grid.points[i]);
    const ci = Math.floor((px - minX) / cellSize);
    const cj = Math.floor((py - minY) / cellSize);
    const list = [];
    for (let a = ci - span; a <= ci + span; a++) {
      for (let b = cj - span; b <= cj + span; b++) {
        const bucket = cellMap.get(a + ',' + b);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j === i) continue;
          const [qx, qy] = pointXY(hm.grid.points[j]);
          const dx = qx - px;
          const dy = qy - py;
          if (dx * dx + dy * dy > r2) continue;
          list.push(j);
        }
      }
    }
    // 桶扫描序本来确定，再排一次是为了让"邻居均值"与建索引的细节无关（用例可复现）
    list.sort((p, q) => p - q);
    lists[i] = list;
    total += list.length;
  }
  const start = new Int32Array(n + 1);
  const adj = new Int32Array(total);
  let at = 0;
  for (let i = 0; i < n; i++) {
    start[i] = at;
    const list = lists[i];
    for (let k = 0; k < list.length; k++) adj[at++] = list[k];
  }
  start[n] = at;
  return { count: n, start, adj, spacing };
}

/**
 * 按流向场下切地形（**公开 API，字段含义不变**；N3b-1 只多回一个 `carve`）。
 *
 * @param {{h:number[], grid:{points:Array, cellsX:number, cellsY:number, spacing:number}}} hm
 *   高度图（就地修改 `h`；`grid` 只读）
 * @param {{seaLevel?:number, isLand?:(x:number,y:number)=>boolean, iterations?:number,
 *          strength?:number, maxDropFrac?:number, onIteration?:(i:number, stats:object)=>void}} [opts]
 * @returns {{iterations:number, carved:number, cells:number, ms:number, perIteration:number[],
 *            segments:Array, carve:Float64Array|null}}
 *   `carved` = 累计下切的高度点总量（诊断/回执用）；
 *   `segments` = **最后一轮**的流向场（每格一条 + `flow`）。它已经是"每格流向哪"的完整答案，
 *   调用方要串河链时直接用它就行 —— 再跑一次 `traceRivers` 只是把同样的事重算一遍（实测 ~80ms/次）。
 *   `carve` = **逐格累计下切量**（新，N3b-1）：谷壁拓宽按它决定两侧要带多深；
 *   缺省（没有段/没跑）时给 `null`。
 */
export function inciseByFlow(hm, opts = {}) {
  const t0 = nowMs();
  const out = {
    iterations: 0, carved: 0, cells: 0, ms: 0, perIteration: [], segments: [], carve: null,
  };
  if (!hm || !Array.isArray(hm.h) || !hm.grid || !Array.isArray(hm.grid.points)) return out;
  const n = hm.h.length;
  if (!n || hm.grid.points.length !== n) return out;

  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const iterations = Math.max(0, Math.min(6, Math.round(Number(opts.iterations) || 0)));
  if (!iterations) return out;
  const strength = Number.isFinite(opts.strength) ? Math.max(0, opts.strength) : INCISE_STRENGTH;
  const dropFrac = Number.isFinite(opts.maxDropFrac)
    ? Math.max(0.05, Math.min(0.9, opts.maxDropFrac)) : INCISE_MAX_DROP_FRAC;
  const isLand = typeof opts.isLand === 'function' ? opts.isLand : null;
  const spacing = Number(hm.grid.spacing) > 0 ? Number(hm.grid.spacing) : 14.4;

  // 格号 → 世界坐标 的反查表（`traceRivers` 的段只给两端坐标；这里按量化坐标查回格号，
  // 而不是假设 grid 是规则格 —— 规则性只在我们自己合成时成立，别把假设埋进算法）
  const indexByPos = buildPosIndex(hm);
  // 逐格累计下切量：谷壁拓宽要用"这个床被切下去多少"，而不是只看最后一轮
  const carveTotal = new Float64Array(n);

  for (let it = 0; it < iterations; it++) {
    // ① 流向场（**唯一实现**：与画布「自动河流」同一份 traceRivers）
    const traced = traceRivers(hm, {
      seaLevel,
      sourceHeight: seaLevel + 0.5,      // 让**所有**陆格参与流向场（不是只从高处起河）
      minPoints: 2,
      coalesce: false,
      isLand: isLand || undefined,
      sourceInlandCells: 0,
    });
    const segments = traced.segments || [];
    if (!segments.length) break;
    // 最后一轮的流向场留给调用方（串河链时直接复用，省一次 traceRivers —— 实测 ~80ms）
    out.segments = segments;

    // ② 流量上界（归一化用本轮的分布，不用绝对公式 —— 同一份地形换个分辨率量纲就变）
    let maxFlow = 1;
    for (const s of segments) if (s.flow > maxFlow) maxFlow = s.flow;
    const flowNorm = (f) => Math.pow(Math.max(1, f) / maxFlow, INCISE_FLOW_EXP);

    // ③ 逐段下切（先把"要切多少"算完再统一应用：边算边切会让同一轮内的坡度互相污染）
    const carve = new Float64Array(n);
    let touches = 0;
    for (const s of segments) {
      const a = Number.isFinite(s.cell) ? s.cell : indexByPos.get(keyOf(s.x0, s.y0));
      if (!Number.isInteger(a) || a < 0 || a >= n) continue;
      const b = indexByPos.get(keyOf(s.x1, s.y1));
      if (!Number.isInteger(b) || b < 0 || b >= n || b === a) continue;
      const drop = hm.h[a] - hm.h[b];
      if (!(drop > 0)) continue;                  // 只切"确实往下流"的那一段
      const slope = drop / spacing;
      const want = strength * flowNorm(s.flow) * Math.pow(Math.min(1, slope * 6), INCISE_SLOPE_EXP);
      const cap = drop * dropFrac;
      const take = Math.max(0, Math.min(want, cap));
      if (take > 0) { carve[a] = Math.max(carve[a], take); touches++; }
    }
    let carved = 0;
    for (let i = 0; i < n; i++) {
      if (carve[i] <= 0) continue;
      // 不低于海平面（切穿了就是海，会把陆地占比打乱）
      const next = Math.max(seaLevel + 0.2, hm.h[i] - carve[i]);
      const gone = hm.h[i] - next;
      carved += gone;
      carveTotal[i] += gone;
      hm.h[i] = Math.round(next * 100) / 100;
    }
    out.perIteration.push(Math.round(carved * 10) / 10);
    out.carved += carved;
    out.iterations++;
    out.cells = touches;
    if (typeof opts.onIteration === 'function') {
      try { opts.onIteration(it, { carved, segments: segments.length, maxFlow }); } catch (_) { /* 回调不许打断侵蚀 */ }
    }
    if (carved <= 0) break;
  }
  out.carve = out.iterations ? carveTotal : null;
  out.carved = Math.round(out.carved * 10) / 10;
  out.ms = Math.round(nowMs() - t0);
  return out;
}

/**
 * **谷壁拓宽**（N3b-1①）：沿排水网络把河床两侧按 V 字剖面向下带。
 *
 * 为什么必须做：`inciseByFlow` 只把**床**那一格切下去，邻居一格不动 —— 放大看是"一条缝"，
 * 不是"被水切出来的谷"。这里以床面累计下切量 `carve[a]` 为深度基准，距床 1 跳的邻居最多
 * 带下 `bedDepth × frac × flowGate`，2 跳再乘个衰减（V 形），流量越大谷越宽。
 *
 * 三条硬约束：
 *   · 谷壁永远高于床面 `VALLEY_BED_MARGIN`（否则谷壁成了新河床，水不知道该往哪走）；
 *   · **河格只能"安全地"被带下**：本来也是河格的邻居最多降到"它自己的下游 + ε"，
 *     既不会把谷壁留在半空，也绝不会制造断头河（守卫靠**下限**而不是"整片不动"：
 *     侵蚀里所有陆格都参与流向场，按"河格不动"排除等于一格都拓不了 —— 实测 0 格）；
 *   · 不下探到海平面以下（海岸线不变）。
 *
 * @param {object} hm 高度图（就地修改 `h`）
 * @param {Array} segments `traceRivers` 的段（`inciseByFlow().segments`）
 * @param {{seaLevel?:number, radius?:number, frac?:number, carve?:Float64Array|null,
 *          neighborhood?:object, down?:Int32Array|null}} [opts]
 * @returns {{cells:number, carved:number, maxDrop:number, radius:number, ms:number}}
 */
export function widenValleys(hm, segments, opts = {}) {
  const t0 = nowMs();
  const out = { cells: 0, carved: 0, maxDrop: 0, radius: 0, ms: 0 };
  if (!hm || !Array.isArray(hm.h) || !hm.grid || !Array.isArray(hm.grid.points)) return out;
  if (!Array.isArray(segments) || !segments.length) return out;
  const n = hm.h.length;
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const radius = Math.max(1, Math.min(4, Math.round(Number.isFinite(opts.radius) ? opts.radius : VALLEY_WALL_RADIUS)));
  const frac = Number.isFinite(opts.frac) ? clamp(opts.frac, 0, 1) : VALLEY_WALL_FRAC;
  const nb = opts.neighborhood && opts.neighborhood.start ? opts.neighborhood : buildNeighborhood(hm);
  if (!nb.start) return out;
  const { start, adj } = nb;
  const carve = opts.carve && opts.carve.length === n ? opts.carve : null;

  const segs = parseSegments(hm, segments);
  if (!segs.count) return out;
  const down = opts.down && opts.down.length === n ? opts.down : buildDownstream(segs, n);

  let maxFlow = 1;
  for (let k = 0; k < segs.count; k++) if (segs.flow[k] > maxFlow) maxFlow = segs.flow[k];

  // 先算完整张"每格要下切多少"（取最大值，不累加）：同一次调用里结果与段的遍历顺序无关
  const cut = new Float64Array(n);
  const stamp = new Int32Array(n).fill(-1);
  for (let k = 0; k < segs.count; k++) {
    const a = segs.a[k];
    const b = segs.b[k];
    const drop = Number(hm.h[a]) - Number(hm.h[b]);
    if (!(drop > 0)) continue;
    const bedDepth = carve ? carve[a] : drop * 0.5;
    if (!(bedDepth > 0.05)) continue;
    // 流量门：干流的谷宽、支流的谷窄 —— "drainage-guided" 就体现在这里
    const flowGate = 0.35 + 0.65 * Math.pow(Math.max(1, segs.flow[k]) / maxFlow, INCISE_FLOW_EXP);
    const want0 = bedDepth * frac * flowGate;
    const bed = Number(hm.h[a]);
    let frontier = [a];
    stamp[a] = k;
    for (let d = 1; d <= radius; d++) {
      const nextFrontier = [];
      const profile = 1 - ((d - 1) / radius) * 0.65;      // 1 跳 → 1.0，2 跳 → 0.675，…
      for (let f = 0; f < frontier.length; f++) {
        const node = frontier[f];
        for (let m = start[node]; m < start[node + 1]; m++) {
          const c = adj[m];
          if (stamp[c] === k) continue;                   // 短路：近的那一跳优先（切得更深）
          stamp[c] = k;
          nextFrontier.push(c);
          if (Number(hm.h[c]) < seaLevel + 0.2) continue; // 海/海岸带不动
          if (Number(hm.h[c]) <= bed + VALLEY_BED_MARGIN) continue;   // 已经不比床高
          // 上限①：必须高于**本段**床面（谷壁不许变成第二条床）
          let cap = Number(hm.h[c]) - bed - VALLEY_BED_MARGIN;
          // 上限②：若 c 自己也是河格，必须留在"它自己的下游 + ε"之上（断头河守卫第一道）
          const dn = down[c];
          if (dn >= 0) {
            const keep = Number(hm.h[dn]) + RIVER_DESCENT_EPS;
            if (keep > bed) cap = Math.min(cap, Number(hm.h[c]) - keep);
          }
          const take = Math.max(0, Math.min(want0 * profile, cap));
          if (take > cut[c]) cut[c] = take;
        }
      }
      frontier = nextFrontier;
      if (!frontier.length) break;
    }
  }

  for (let i = 0; i < n; i++) {
    if (!(cut[i] > 0)) continue;
    const prev = Number(hm.h[i]);
    const next = Math.max(seaLevel + 0.2, prev - cut[i]);
    const gone = prev - next;
    if (!(gone > 0)) continue;
    out.carved += gone;
    out.cells++;
    if (gone > out.maxDrop) out.maxDrop = gone;
    hm.h[i] = round2(next);
  }
  out.radius = radius;
  out.carved = Math.round(out.carved * 10) / 10;
  out.maxDrop = Math.round(out.maxDrop * 100) / 100;
  out.ms = Math.round(nowMs() - t0);
  return out;
}

/**
 * **坡面松弛（talus relaxation，N3b-1②）**：只削峰、按坡度阈值选择性生效。
 *
 * 与"全图三次均值滤波"的区别（这是这个函数存在的全部理由）：
 *   · **只削峰**：`h - 邻居均值 <= 0` 的格一律不动 → 谷底、斜坡不会被抬起来（不会糊成面团）；
 *   · **坡度门**：最大邻差低于 `TALUS_SLOPE_THRESHOLD` 视为平地，`gate = 0` 一点不动 → 平原不受影响；
 *   · **河床保护**：河格的松弛值有硬下限 `下游高度 + RIVER_DESCENT_EPS`，
 *     所以"削峰"不会把河床削到下游以下（断头河守卫的第二道）。
 *
 * 数学上这个更新不会让格子低于任何邻居（新值 > 邻居均值 > 最小邻居），所以本身不会造坑；
 * 河床下限是给"削峰后坡度几乎持平"的边界情形留的最后一道。
 *
 * @param {object} hm 高度图（就地修改 `h`）
 * @param {{seaLevel?:number, passes?:number, rate?:number, slope?:number,
 *          neighborhood?:object, down?:Int32Array|null}} [opts]
 * @returns {{passes:number, cells:number, moved:number, maxDrop:number, ms:number}}
 */
export function relaxSlopes(hm, opts = {}) {
  const t0 = nowMs();
  const out = { passes: 0, cells: 0, moved: 0, maxDrop: 0, ms: 0 };
  if (!hm || !Array.isArray(hm.h) || !hm.grid || !Array.isArray(hm.grid.points)) return out;
  const n = hm.h.length;
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const passes = clamp(Math.round(Number.isFinite(opts.passes) ? opts.passes : 2), 0, 4);
  const rate = clamp(Number.isFinite(opts.rate) ? opts.rate : TALUS_RATE, 0, 0.5);
  const slope = Number.isFinite(opts.slope) && opts.slope > 0 ? opts.slope : TALUS_SLOPE_THRESHOLD;
  if (!passes || !(rate > 0)) return out;
  const nb = opts.neighborhood && opts.neighborhood.start ? opts.neighborhood : buildNeighborhood(hm);
  if (!nb.start) return out;
  const { start, adj } = nb;
  const down = opts.down && opts.down.length === n ? opts.down : null;
  const gateHi = slope * TALUS_GATE_SPAN;
  const floorH = seaLevel + 0.2;

  // 快照 → 新图 → 快照：同一轮内所有格都读"上一轮的值"，结果与遍历顺序无关（确定性）
  let src = new Float64Array(n);
  for (let i = 0; i < n; i++) src[i] = Number(hm.h[i]) || 0;
  let next = new Float64Array(n);
  const changed = new Uint8Array(n);          // 去重计数（cells 是"改过的格数"，不是"格·轮"）
  for (let p = 0; p < passes; p++) {
    next.set(src);
    let moved = 0;
    let maxDrop = 0;
    for (let i = 0; i < n; i++) {
      const hi = src[i];
      if (hi < floorH) continue;              // 海格 / 海岸带不松弛（海岸线是别的模块算好的）
      const s0 = start[i];
      const s1 = start[i + 1];
      if (s1 <= s0) continue;
      let sum = 0;
      let maxAbs = 0;
      for (let m = s0; m < s1; m++) {
        const hj = src[adj[m]];
        sum += hj;
        const d = hi - hj;                    // 只关心"比邻居高多少"
        if (d > maxAbs) maxAbs = d;
      }
      if (!(maxAbs > 0)) continue;
      const mean = sum / (s1 - s0);
      if (!(hi > mean)) continue;             // 只削峰：比邻居均值低的格不动
      const gate = smoothstep01(slope, gateHi, maxAbs);
      if (!(gate > 0)) continue;
      let nh = hi - rate * gate * (hi - mean);
      if (nh < floorH) nh = floorH;
      nh = round2(nh);
      const dn = down ? down[i] : -1;
      if (dn >= 0) {
        // 河床保护（第一道断头河守卫）。⚠️ 必须在 round2 之后再做一次：两位小数四舍五入
        // 会把 0.01 的余量吃掉（实测：只在前一步夹取时，8k 夹具上兜底修复被触发 47 次）。
        const keep = src[dn] + RIVER_DESCENT_EPS;
        if (nh < keep) nh = Math.ceil(keep * 100) / 100;
      }
      if (!(nh < hi)) continue;               // 只往下，绝不抬升（抬升会把别处的坡向改掉）
      next[i] = nh;
      moved++;
      changed[i] = 1;
      if (hi - nh > maxDrop) maxDrop = hi - nh;
    }
    src = next;
    next = new Float64Array(n);
    out.passes++;
    out.moved += moved;
    if (maxDrop > out.maxDrop) out.maxDrop = maxDrop;
    if (!moved) break;
  }
  for (let i = 0; i < n; i++) hm.h[i] = src[i];
  for (let i = 0; i < n; i++) if (changed[i]) out.cells++;
  out.maxDrop = Math.round(out.maxDrop * 100) / 100;
  out.ms = Math.round(nowMs() - t0);
  return out;
}

/**
 * **断头河后置检查**（N3b-1③）：河格不得低于它的下游格。
 *
 * 判据口径（写死，别在调用处另解释）：
 *   · `broken` = 河格 `a` 的高度 **严格低于** 下游格 `b`（`h[a] < h[b]`）→ 水倒流/断头；
 *   · `flat`  = `h[a] == h[b]`（两格等高）→ 水失去方向，也是缺陷，但**与断头分开计数**；
 *   · `checked` = 参与判定的段数；`worst` = 最严重的倒挂量（高度点）。
 *
 * @param {object} hm 高度图（只读）
 * @param {Array} segments `traceRivers` 的段
 * @returns {{broken:number, flat:number, checked:number, worst:number, firstCell:number, ms:number}}
 */
export function countBrokenRivers(hm, segments, opts = {}) {
  const t0 = nowMs();
  const out = { broken: 0, flat: 0, checked: 0, worst: 0, firstCell: -1, ms: 0 };
  if (!hm || !Array.isArray(hm.h) || !Array.isArray(segments) || !segments.length) return out;
  const tolerance = Number.isFinite(opts.tolerance) ? Math.max(0, opts.tolerance) : 1e-9;
  const segs = parseSegments(hm, segments);
  out.checked = segs.count;
  for (let k = 0; k < segs.count; k++) {
    const a = segs.a[k];
    const b = segs.b[k];
    const diff = Number(hm.h[b]) - Number(hm.h[a]);   // > 0 = a 比下游还低
    if (diff > tolerance) {
      out.broken++;
      if (diff > out.worst) { out.worst = diff; out.firstCell = a; }
    } else if (Math.abs(diff) <= tolerance) {
      out.flat++;
    }
  }
  out.worst = Math.round(out.worst * 100) / 100;
  out.ms = Math.round(nowMs() - t0);
  return out;
}

/**
 * **兜底修复**：把倒挂的河格抬到 `下游 + eps`（只抬不降，海平面/陆地占比不受影响）。
 *
 * 设计上它**不该被用到**（下切有落差封顶、拓谷有"自己的下游 + ε"上限、削峰有河床下限），
 * 留在这是为了：万一以后有人改了某条通路，`erodeTerrain` 仍能保证"没有断头河"，
 * 同时把 `repaired` 计数暴露出来 —— 非 0 就说明上面三道守卫漏了，要查，而不是悄悄修掉。
 *
 * ⚠️ `eps` 默认 **0**：只修**真正的倒挂**（`h[a] < h[b]`）。判据里的"断头"是"坑比下游深"，
 *    不是"落差小于 1 厘米"—— 后者在 2 位小数的舍入下遍地都是（会淹没真正的信号）。
 *
 * @returns {{checked:number, repaired:number, passes:number, ms:number}}
 */
export function enforceRiverDescent(hm, segments, opts = {}) {
  const t0 = nowMs();
  const out = { checked: 0, repaired: 0, passes: 0, ms: 0 };
  if (!hm || !Array.isArray(hm.h) || !Array.isArray(segments) || !segments.length) return out;
  const eps = Number.isFinite(opts.eps) ? Math.max(0, opts.eps) : 0;
  const maxPasses = clamp(Math.round(Number.isFinite(opts.maxPasses) ? opts.maxPasses : 3), 1, 8);
  const segs = parseSegments(hm, segments);
  out.checked = segs.count;
  if (!segs.count) return out;
  const order = new Int32Array(segs.count);
  for (let i = 0; i < segs.count; i++) order[i] = i;
  for (let p = 0; p < maxPasses; p++) {
    // 按"下游高度升序"修：先修最低的一段，被抬高的格子不会推翻已经修好的上游
    order.sort((q, r) => (Number(hm.h[segs.b[q]]) - Number(hm.h[segs.b[r]])) || (segs.a[q] - segs.a[r]));
    let changed = 0;
    for (let i = 0; i < order.length; i++) {
      const k = order[i];
      const a = segs.a[k];
      const b = segs.b[k];
      const cur = Number(hm.h[a]);
      const need = Number(hm.h[b]) + eps;
      if (cur < need) {
        // 向上取到两位小数：保证修完仍然 > need（四舍五入可能又掉回去）
        hm.h[a] = Math.ceil(need * 100) / 100;
        changed++;
      }
    }
    out.passes++;
    out.repaired += changed;
    if (!changed) break;
  }
  out.ms = Math.round(nowMs() - t0);
  return out;
}

/**
 * **N3b-1 主入口**：下切 → 拓谷 → 削峰 → 断头河守卫，一次跑完。
 *
 * 顺序是刻意的：
 *   1. `inciseByFlow`（N 轮）：先把水系切出来，同时给出最后一轮流向场（供河流串链复用）；
 *   2. `widenValleys`：按**逐格累计切掉的深度**（`carve`）把谷壁带下来 → V 形谷；
 *   3. `relaxSlopes`：削峰（河格有下限）→ 山脊变圆、坡面出现侵蚀细节，平原不动；
 *   4. `enforceRiverDescent` + `countBrokenRivers`：兜底修复 + 后置断言，返回诊断计数。
 *
 * 返回对象**包含 `inciseByFlow` 的全部字段且含义不变**（`iterations / carved / cells / segments /
 * perIteration / ms`），另外新增 `widen* / relax* / broken* / repaired / timings` 诊断。
 *
 * @param {object} hm 高度图（就地修改 `h`）
 * @param {{seaLevel?:number, isLand?:Function, iterations?:number, strength?:number,
 *          maxDropFrac?:number, onIteration?:Function, widen?:boolean, relax?:boolean,
 *          widenRadius?:number, widenFrac?:number, relaxPasses?:number, relaxRate?:number,
 *          relaxSlope?:number, ensureDescent?:boolean}} [opts]
 * @returns {{iterations:number, carved:number, cells:number, ms:number, perIteration:number[],
 *            segments:Array, carve:Float64Array|null, widenCells:number, widenCarved:number,
 *            relaxCells:number, relaxMoved:number, brokenRivers:number, brokenChecked:number,
 *            brokenWorst:number, brokenFlat:number, repaired:number, timings:object}}
 */
export function erodeTerrain(hm, opts = {}) {
  const t0 = nowMs();
  const out = {
    iterations: 0,
    carved: 0,
    cells: 0,
    ms: 0,
    perIteration: [],
    segments: [],
    carve: null,
    widenCells: 0,
    widenCarved: 0,
    relaxCells: 0,
    relaxMoved: 0,
    brokenRivers: 0,
    brokenChecked: 0,
    brokenWorst: 0,
    brokenFlat: 0,
    repaired: 0,
    timings: { incision: 0, widen: 0, relax: 0, guard: 0 },
  };
  if (!hm || !Array.isArray(hm.h) || !hm.grid || !Array.isArray(hm.grid.points)) return out;
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;

  // ① 下切（原有实现，逐字节不变）
  const incised = inciseByFlow(hm, opts);
  out.iterations = incised.iterations;
  out.carved = incised.carved;
  out.cells = incised.cells;
  out.segments = incised.segments;
  out.carve = incised.carve;
  out.perIteration = incised.perIteration;
  out.timings.incision = incised.ms;
  if (!incised.segments.length) {
    out.ms = Math.round(nowMs() - t0);
    return out;
  }

  // 邻居表只建一次（拓谷 2 跳 BFS 与削峰都用它）—— 18k 格实测 ~25ms，不值得建两次
  const neighborhood = buildNeighborhood(hm);
  const segs = parseSegments(hm, incised.segments);
  const down = buildDownstream(segs, hm.h.length);

  // ② 谷壁拓宽（V 形谷）
  if (opts.widen !== false) {
    const widened = widenValleys(hm, incised.segments, {
      seaLevel,
      radius: opts.widenRadius,
      frac: opts.widenFrac,
      carve: incised.carve,
      neighborhood,
      down,
    });
    out.widenCells = widened.cells;
    out.widenCarved = widened.carved;
    out.timings.widen = widened.ms;
  }

  // ③ 坡面松弛（削峰；河床有下限）
  if (opts.relax !== false) {
    const relaxed = relaxSlopes(hm, {
      seaLevel,
      passes: opts.relaxPasses,
      rate: opts.relaxRate,
      slope: opts.relaxSlope,
      neighborhood,
      down,
    });
    out.relaxCells = relaxed.cells;
    out.relaxMoved = relaxed.moved;
    out.timings.relax = relaxed.ms;
  }

  // ④ 断头河守卫：兜底修复（只抬不降）→ 后置断言计数
  if (opts.ensureDescent !== false) {
    const repaired = enforceRiverDescent(hm, incised.segments, { eps: opts.descentEps });
    out.repaired = repaired.repaired;
  }
  const guard = countBrokenRivers(hm, incised.segments);
  out.brokenRivers = guard.broken;
  out.brokenChecked = guard.checked;
  out.brokenWorst = guard.worst;
  out.brokenFlat = guard.flat;
  out.timings.guard = guard.ms;
  out.ms = Math.round(nowMs() - t0);
  return out;
}
