// utils/riverTrace.js — 自动河流：**沿高度梯度下行**的追踪（纯函数，Node 可测；2026-10-14）
//
// ── 为什么重写这一段 ─────────────────────────────────────────────────────────
// 旧实现（`scenarioEditing.generateRivers`，与 `heightMath.generateRivers` 是同款）对每个高地
// 格子**全表扫描**找最低邻居：
//
//     for (src of 高度>60 的格子)          // 真实底图实测 281~10000+ 个
//        while (没到海 && 步数<200)
//           for (j = 0 .. n)              // n = 9975 / 26910 格
//
// 真实数据实测量级：`desite` 底图 9975 格 / **399 个源头** → 内层 399×n×平均步数；
// 行星 26910 格 / 281 个源头 → 单点全表扫描 7.46 ms × 281 × 上界 200 ≈ **7 分钟**
// （JS 实测同量级）。而它是**同步**跑的：主线程从点下按钮那一刻起就不再响应任何事件，
// 用户看到的就是「毫无征兆直接卡住」——Windows 随后把窗口标成"未响应"。
//
// 现在：**一次最小堆洪泛**定出「每一格流向哪一格」，之后每条河只做一次 O(路径长) 的行走。
// 复杂度从 O(源头 × 格数 × 步数) 降到 O(格数·log 格数 + 总路径长)，实测见回归用例。
//
// ── 三条必须遵守的口径（都是本模块存在的原因）───────────────────────────────
//   ① **水只往低处流**：接收者必须**严格更低**（`h[j] < h[i]`）。旧实现取"半径内最小者"，
//      完全不判它是不是比自己低 → 一步就能"走上坡"，追踪会在山脊上来回打转直到撞上
//      200 步上限，然后被当成一条河画出来（地图上凭空多一条平直的长线）。
//   ② **不能到海的洼地不算源头**：大陆内部的闭合洼地（局部最低点）旧实现追到 `lowest < 0`
//      就 `break`，那条"河"只要凑够 4 个点照样画出来 —— 这就是"内陆凭空一条河"。
//      现在用插入式优先队列从**海格**向上洪泛，只有能被洪泛到的格子才算"能到海"。
//      单调性有保证：出堆时高度单调不减，每一步的接收者必定已被标记 → 路径一定越走越低，
//      不会出现"下坡半路又爬回高处"。
//   ③ **邻居口径与旧实现一致**：半径仍是 `spacing × 1.5`（不是 8 邻域 / 4 邻域）。
//      换口径会让"同一份高度图，升级前后流出来的河不一样"，而这种变化**看起来**只是
//      "河流位置变了"，没人会想到是邻居口径改了。距离过滤照旧用真实欧氏距离。
//
// ⚠️ 本模块只做**追踪**：不写盘、不走 undo、不碰 store。返回的是内存里的折线，
//    "要不要落盘 / 画多粗"由调用方决定（与 `vertexSharing` / `provinceOverlap` 同一分工）。

import { buildGridIndexWithCellSize, pointXY } from './gridSpatialIndex.js';
import { resampleHeightmap, smoothHeightmapGrid } from './heightmapResample.js';

/** 海平面阈值（与 `heightMath.SEA_LEVEL` / `heightmapRaster.RASTER_SEA_LEVEL` 同口径） */
export const TRACE_SEA_LEVEL = 20;

/** 邻居半径 = 格距 × 该系数（与旧实现逐字一致，见文件头 ③） */
export const TRACE_NEIGHBOR_FACTOR = 1.5;

/** 一条河至少几个点才算数（旧实现 `river.length > 3`） */
export const TRACE_MIN_POINTS = 4;

/** 单条河的步数上限（防病态数据把一次点击拖成无限循环） */
export const TRACE_MAX_STEPS = 2000;

/** 源头高度下限的默认值（旧实现写死 60） */
export const TRACE_SOURCE_HEIGHT = 60;

/**
 * 源头必须**离海至少几格**（默认 2）。
 *
 * 🔴 这条是 2026-10-14 用户实测「河流依旧随机出海」的修法：高程是**格心采样**，海岸线从
 *    格子里穿过 → 一批"明明泡在水里"的格子高度 ≥ 20，它们够高时就会被当源头，
 *    河道于是从海边起步、朝最陡方向射进大洋。要求离海 ≥ 2 格即可挡掉绝大多数这种起点，
 *    而正常入海口（在内陆追下来的那条河）**完全不受影响** —— 我们挡的是"源头"，不是"河口"。
 */
export const TRACE_SOURCE_INLAND_CELLS = 2;

/** 折线平滑的默认迭代次数（渲染时用；0 = 不平滑） */
export const TRACE_SMOOTH_ITERATIONS = 2;

/**
 * **河源**的最小汇流量（默认 1 = 只要有上游就成河）。
 *
 * 🔴 2026-10-14 第三修（用户实测「很丑 / 僵硬折线」的主因之一）：源头原来取**每一个**高地格
 *    （真实底图 399 个）→ 一大片互相不连的短促支沟，既不像河、线宽也无从分级。
 *    这条闸门挡掉的是"**没有任何上游**的孤立格"（flow 恰好 = 1），留下的都是汇流节点。
 *
 * ⚠️ **别按"只留大江"的思路调大它**：这份高度图的汇流量**量程极窄**
 *    （真实底图实测：中位 12 / 最大 21 —— 格距内高差小、微洼地多，流域碎成一片）。
 *    设 2 → 出图从 111 条掉到 10 条；设 6 → **一条都不剩**。
 *    大江靠**线宽分级**（`Math.cbrt(flow)`）体现，不靠砍条数。
 */
export const TRACE_CHANNEL_INIT = 1;

/**
 * **河网合并**：同一个流域只画一条（从源头认领到海），沿途已被更大流量那条河认领的
 * 上游端点直接跳过 —— 旧口径下同一条干流会被反复画很多遍。
 *
 * 🔴 三条**实测**结论（真实的 `desite` 底图 9975 格 / 2506 陆格；全部可复现：
 *    `python scripts/tests/tools/compare_river_opts.py --grid-json <抽出来的网格>`）：
 *
 *   ① **源头闸门（`channelInit`，默认 1）才是真正在起作用的那一个**：它挡掉"没有任何上游"
 *      的孤立格。实测：源头高度 >60 时，够高又能到海的格只剩 **152 个**，其中 132 个被
 *      "离海 <2 格"挡住、其余多是孤立格（flow=1）→ 出图 **3 条**。想要更多支流就
 *      **降低 `sourceHeight`**：降到 40 → **67 条**（同一份数据）。
 *   ② **合并的收益是"少了重复"，不是"多了长河"**：实测最长河的世界长度两边都是 111
 *      世界单位 —— 这份地形**本来就没有更长的河**（最远陆点离海 11 格 / 158 单位，
 *      而这张图横跨 1913 单位）。详见 `docs/RIVER_NATURALNESS_AND_RESOLUTION_20261014.md`。
 *   ③ 曾经有一个"沿途流量分位闸门"，**实测在本数据上永远不触发**（候选格汇流量只有 1~21，
 *      任何分位都落在下限上）→ 已删除。留一个不起作用的参数 + 一句骗人的注释，比删掉更坏。
 */


/** 合并后一条河至少几个点才算数（合并版把"到海"整段都算上，所以门槛比 TRACE_MIN_POINTS 高） */
export const TRACE_COALESCE_MIN_POINTS = 3;

/**
 * 河网合并的**默认开关**。
 *
 * ⚠️ 之所以做成"显式传了 `channelInit` 就退回旧口径"：`channelInit` 是老 API 里
 *    "源头最小汇流量"的旋钮，单测与既有行为都按它断言。合并是**新**语义，不能悄悄改掉
 *    老参数的读数（那会让"阈值调大 → 条数减少"这条断言变成假绿）。
 */
export function coalesceDefault(opts) {
  return opts && opts.channelInit === undefined;
}

// ── 最小堆（只存 (下标, 高度) 对；够用就好，不引依赖）────────────────────────
function heapPush(heap, idx, h) {
  let i = heap.length >> 1;
  heap.push(idx, h);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p * 2 + 1] <= heap[i * 2 + 1]) break;
    const ti = heap[p * 2], th = heap[p * 2 + 1];
    heap[p * 2] = heap[i * 2]; heap[p * 2 + 1] = heap[i * 2 + 1];
    heap[i * 2] = ti; heap[i * 2 + 1] = th;
    i = p;
  }
}

function heapPop(heap) {
  const topI = heap[0], topH = heap[1];
  const last = heap.length - 2;
  if (last > 0) {
    heap[0] = heap[last]; heap[1] = heap[last + 1];
    heap.length = last;
    let i = 0;
    const n = heap.length >> 1;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < n && heap[l * 2 + 1] < heap[m * 2 + 1]) m = l;
      if (r < n && heap[r * 2 + 1] < heap[m * 2 + 1]) m = r;
      if (m === i) break;
      const ti = heap[m * 2], th = heap[m * 2 + 1];
      heap[m * 2] = heap[i * 2]; heap[m * 2 + 1] = heap[i * 2 + 1];
      heap[i * 2] = ti; heap[i * 2 + 1] = th;
      i = m;
    }
  } else {
    heap.length = 0;
  }
  return [topI, topH];
}

/**
 * 追踪自动河流。
 *
 * @param {{h: ArrayLike<number>, grid: {points:Array, spacing?:number}}} hm 高度图
 * @param {{sourceHeight?:number, seaLevel?:number, minPoints?:number, maxSteps?:number,
 *          neighborFactor?:number, maxDistance?:number,
 *          isLand?:(x:number,y:number)=>boolean,
 *          sourceInlandCells?:number, smooth?:number,
 *          upsample?:number, maxUpsampleCells?:number,
 *          smoothRadius?:number, smoothPasses?:number,
 *          coalesce?:boolean, channelInit?:number}} [opts]
 *   `isLand` = 由调用方注入的**陆地判定**（给了它就会把源头限制在离海至少
 *   `sourceInlandCells` 格的格子上；不给则退回"只按高度判"）。
 *   `upsample` = 追踪前先把高度图**双线性放大** N 倍（默认 1 = 用原网格）。
 *     ⚠️ 这是**精度**选项，不是"变出长河"的选项：真实底图实测 1→2→4 倍时，
 *     河条数 57→287→1089、最长河 8→14→25 点，而**最长河的世界长度几乎不变**
 *     （111→120→110 世界单位）—— 放大只让同一片地形被更细地走一遍。
 *     要更长的大河只能换更高分辨率的**源数据**（见 docs 里的实测表）。
 *   `smoothRadius` / `smoothPasses` = 追踪前先把 `h` 做盒滤波（默认 0 = 关）。
 *     🔴 与 `upsample` **方向相反、效果也相反**：放大是"走得更细"（实测**河更碎**：
 *     1710→6342 段、最长 140→110）；平滑是"抹掉微洼地、让水顺着大谷走"
 *     （实测 r=2 p=1：最长河 **140→270**、中位 69→92，河网铺开到全岛）。
 *     ⚠️ **代价**：平滑压低山头 → 源头高度闸门更难满足（r=3 p=3 实测 **0 条河**）。
 *     所以开启时调用方应**同时下调 `sourceHeight`**，并把这两件事一起回执给用户。
 *   `coalesce` = 河网合并（默认在**没有显式传 `channelInit`** 时开启，见 `coalesceDefault`）。
 * @returns {{rivers: Array<{points: Array<{x:number,y:number}>, flow:number, len:number,
 *            flows?:Float64Array, maxFlow?:number, order?:number, endInSea:boolean,
 *            mouthFlow:number, cutByFlow?:boolean, srcIndex?:number}>,
 *            sources:number, reaching:number, dropped:number, cells:number, neighborFactor:number,
 *            elapsedMs:number, truncated:boolean, coastSources:number, maxFlow:number,
 *            coalesced:boolean, upsample:number, medianFlow:number}}}
 */
export function traceRivers(hm, opts = {}) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const empty = {
    rivers: [], sources: 0, reaching: 0, dropped: 0, cells: 0,
    neighborFactor: TRACE_NEIGHBOR_FACTOR, elapsedMs: 0, truncated: false,
    coastSources: 0, maxFlow: 0, coalesced: false,
    medianFlow: 0, upsample: 1, upsampleNote: '', smoothed: 0, smoothNote: '', spacing: 0,
    sourceHeight: TRACE_SOURCE_HEIGHT, sourceInlandCells: TRACE_SOURCE_INLAND_CELLS,
    segments: [], segMaxFlow: 0, basins: [], basinCells: 0,
  };
  if (!hm || !hm.grid || !Array.isArray(hm.grid.points) || !hm.h) return empty;

  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : TRACE_SEA_LEVEL;
  const sourceHeight = Number.isFinite(opts.sourceHeight) ? opts.sourceHeight : TRACE_SOURCE_HEIGHT;
  const coalesced = opts.coalesce !== undefined ? !!opts.coalesce : coalesceDefault(opts);
  const minPointsRaw = Number.isFinite(opts.minPoints) ? Math.max(2, opts.minPoints) : null;
  const minPoints = minPointsRaw != null ? minPointsRaw : (coalesced ? TRACE_COALESCE_MIN_POINTS : TRACE_MIN_POINTS);
  const maxSteps = Number.isFinite(opts.maxSteps) ? opts.maxSteps : TRACE_MAX_STEPS;
  const factor = Number.isFinite(opts.neighborFactor) ? opts.neighborFactor : TRACE_NEIGHBOR_FACTOR;
  let isLand = (typeof opts.isLand === 'function') ? opts.isLand : null;
  const sourceInlandCells = Number.isFinite(opts.sourceInlandCells) ? Math.max(0, opts.sourceInlandCells) : TRACE_SOURCE_INLAND_CELLS;
  const channelInit = Number.isFinite(opts.channelInit) ? Math.max(1, opts.channelInit) : TRACE_CHANNEL_INIT;

  // ── ⓿ 可选：先把高度图放大（精度选项，改的是"走多细"，不是"有没有地形"）─────────
  // 放大后 `spacing` 变小、格心世界坐标的最外圈不变；陆地判定（`isLand`）按**世界坐标**问，
  // 所以对它完全透明 —— 这正是 `heightmapResample` 坚持"格心对齐"的原因。
  let upsample = 1;
  let upsampleNote = '';
  if (Number.isFinite(opts.upsample) && opts.upsample > 1) {
    const rr = resampleHeightmap(hm, opts.upsample, { maxCells: Number.isFinite(opts.maxUpsampleCells) ? opts.maxUpsampleCells : undefined });
    if (rr.ok) {
      hm = rr.heightmap;
      upsample = rr.stats.factor;
    } else {
      // ⚠️ 不静默失败：放大不了就按原网格跑，并把原因回报给调用方显示
      upsampleNote = rr.message || '放大失败，已按原网格追踪';
    }
  }

  // ── ⓿b 可选：追踪前**平滑**高度（`opts.smoothRadius` / `opts.smoothPasses`）────────
  //
  // 🔴 为什么需要它（2026-10-16 用户实测截图：「很丑的折线，有种恐怖感」）：
  //    把自动河网单独渲成图看（`_render_river_compare.mjs`），它是**几百根短、直、放射状的小棍**，
  //    而地图自带河是**又长又弯、几乎贯通全岛的主干**。根因不是配色/线宽，是**几何分辨率**：
  //    真实底图的高度图只有 **133×75 / 格距 14.4**（岛宽 1700），
  //    → 最长代表路径只有 **140 世界单位 = 岛宽的 8%**，段长中位 **1.2 格**。
  //    `:331-334` 那段注释也写明这个两难：只按原始高度 → 微洼地成终点（最长 10 格）；
  //    只按水位 → **一片放射状短支沟**（就是现状）。
  //
  //    实测（`_proto_smooth_trace.mjs`，真实 desite 底图）：先做 r=2 p=1 的盒滤波再追踪 →
  //    **最长河 140 → 270（约 2 倍）**、中位 69 → 92，河网分布也铺开到全岛而不是挤在海岸。
  //
  // ⚠️ **代价必须一起说**：平滑会把山头压低 → **源头高度闸门越来越难满足**。
  //    实测 `r=3 p=3` 直接 **0 条河**（源头全被削没了）。所以调用方开平滑时应**同时下调**
  //    `sourceHeight`，否则用户看到的是"开了平滑反而一条河都没有"。
  // ⚠️ 默认**关**（`smoothRadius` 不传就是 0）→ 行为与以前**一字不差**。
  // ⚠️ 平滑走产品自己的 `smoothHeightmapGrid`（**只改 `h`**、保留网格与其它通道）——
  //    不在这里手写一份卷积（本项目已多次踩过"两份实现"）。
  let smoothed = 0;
  let smoothNote = '';
  if (Number.isFinite(opts.smoothRadius) && opts.smoothRadius > 0) {
    const passes = Number.isFinite(opts.smoothPasses) && opts.smoothPasses > 0 ? Math.min(4, opts.smoothPasses) : 1;
    const sr = smoothHeightmapGrid(hm, { radius: opts.smoothRadius, passes });
    if (sr && sr.ok !== false && sr.heightmap) {
      hm = sr.heightmap;
      smoothed = Number.isFinite(sr.stats?.radius) ? sr.stats.radius : opts.smoothRadius;
    } else {
      smoothNote = (sr && sr.message) || '平滑失败，已按原高度追踪';
    }
  }

  const pts = hm.grid.points;
  const n = pts.length;
  if (!n || hm.h.length !== n) return empty;
  const spacing = (hm.grid.spacing || 14.4);
  const radius = Number.isFinite(opts.maxDistance) ? opts.maxDistance : spacing * factor;
  const r2 = radius * radius;

  // 高度拷贝成 Float64Array：`hm.h` 在项目文件里可能是普通 Array（读起来要走装箱），
  // 而下面是一个 n·邻居数 的热循环。
  const H = new Float64Array(n);
  for (let i = 0; i < n; i++) H[i] = Number(hm.h[i]) || 0;

  const index = buildGridIndexWithCellSize(hm.grid, Math.max(radius, spacing));
  if (!index) return empty;
  const { cellSize, minX, minY, cellMap } = index;
  const span = Math.ceil(radius / cellSize);

  /** 邻居（含距离过滤；桶索引 → O(邻居数)） */
  const neighborsOf = (i, out) => {
    out.length = 0;
    const [px, py] = pointXY(pts[i]);
    const ci = Math.floor((px - minX) / cellSize);
    const cj = Math.floor((py - minY) / cellSize);
    for (let a = ci - span; a <= ci + span; a++) {
      for (let b = cj - span; b <= cj + span; b++) {
        const bucket = cellMap.get(a + ',' + b);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j === i) continue;
          const [qx, qy] = pointXY(pts[j]);
          const dx = qx - px, dy = qy - py;
          if (dx * dx + dy * dy > r2) continue;
          out.push(j);
        }
      }
    }
    return out;
  };

  // ── ① 「陆地」与「离海几格」───────────────────────────────────────────────
  // 🔴 用户 2026-10-14 实测「河流依旧随机出海」的根因就在这一层：水位面以下的格子里，
  //    有一批**贴着海岸、高度却 ≥ 20** 的格子（高程数据是格心采样，海岸线从格里穿过）。
  //    它们满足"高度 > 60 且能到海"时就会被当源头，于是河道从海边起步、朝最陡的方向
  //    一头扎进海里 —— 观感就是"凭空一条线射向大洋"。
  //    `isLand` 由调用方注入（画布侧用省份多边形，测试用注入的谓词），这里只负责把
  //    "离海 ≥ N 格"算出来并据此挡源头。BFS 一遍 = O(n)。
  const seaDist = new Int32Array(n).fill(-1);      // -1 = 没算（无 isLand 时全部跳过）
  let coastSources = 0;
  if (isLand) {
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = pointXY(pts[i]);
      let land = false;
      try { land = !!isLand(x, y); } catch (_) { land = true; }   // 判定抛错 → 当陆地（不误杀）
      if (!land) { seaDist[i] = 0; queue[qt++] = i; }
    }
    const tmp = [];
    while (qh < qt) {
      const i = queue[qh++];
      const d = seaDist[i];
      const nb = neighborsOf(i, tmp);
      for (let k = 0; k < nb.length; k++) {
        const j = nb[k];
        if (seaDist[j] !== -1) continue;
        seaDist[j] = d + 1;
        queue[qt++] = j;
      }
    }
  }

  // ── ② 洼地填平（priority-flood）→ 流向场：每格流进**最低的那个邻居** ──────
  //
  // 为什么非填不可：这份高度图（真实底图 9975 格）**3055 个陆格里 1499 个是局部最低点**
  // —— 格距 14.4 世界单位内的高差只有 1~2，微洼地遍地都是。不填的话：
  //   · 一半陆地根本没有出口（口径②只能把它们整片丢掉，河网碎成一片短支沟）；
  //   · 汇流量最大只有 21（一个流域只有 21 格）→ 线宽分级失效、主干无从谈起。
  // 填法就是教科书那条：从海格起做**最小堆洪泛**，把每格的"可流出的水位"抬到它的溢流点
  // （`filled[i] = max(H[i], 从海到 i 的所有路径里最低的那条峰值)`）。单调性有保证：
  // 洪泛过程中先被弹出的（水位数更低的）一定在更下游。
  //
  // ⚠️ **填的是流向场，不是数据**：`filled` 只在本函数的内存里活着，绝不写回高度图
  // （用户的 h 一个字节都不动）。这条纪律与 A1「高度图写入统一走 commitHeightmap」同源。
  const filled = new Float64Array(n);
  const done = new Uint8Array(n);
  const heap = [];
  for (let i = 0; i < n; i++) {
    if (H[i] < seaLevel) {
      filled[i] = H[i];
      done[i] = 1;
      heapPush(heap, i, H[i]);
    }
  }
  const nbTmp = [];
  let filledCount = 0;
  while (heap.length) {
    const [i, hi] = heapPop(heap);
    const nb = neighborsOf(i, nbTmp);
    for (let k = 0; k < nb.length; k++) {
      const j = nb[k];
      if (done[j]) continue;
      done[j] = 1;
      const w = H[j] > hi ? H[j] : hi;      // 溢流点：不能低于已定的水位
      filled[j] = w;
      if (w > H[j] + 1e-9) filledCount++;
      heapPush(heap, j, w);
    }
  }

  /**
   * 排序键比较（"谁更下游"）：**主键 = 水位**（保证一定走得出去），**副键 = 原始高度**
   * （同样水位时往真实更低的那格走 —— 谷地在填平后的连片水面上仍然分得出来）。
   *
   * 🔴 两个键的先后顺序都踩过一次，两个方向的假象完全不同：
   *    · **只按原始高度**（水位不参与）→ 微洼地全部变成终点：真实底图实测最长河道只有
   *      **10 格 / 144 世界单位**，而这座岛宽 1700 单位，"河"根本不流。
   *    · **只按水位**（原始高度不参与）→ 每格都朝**离海最近**的方向走 → 一片放射状短支沟，
   *      同样长不起来，而且走向与真实谷地无关。
   *    两个一起用才是对的：水位负责"出得去"，原始高度负责"沿着谷地出去"。
   */
  const keyLess = (a, b) => {
    const fa = filled[a], fb = filled[b];
    if (fa < fb - 1e-12) return true;
    if (fa > fb + 1e-12) return false;
    if (H[a] < H[b] - 1e-12) return true;
    if (H[a] > H[b] + 1e-12) return false;
    return a < b;
  };
  const nbTmp2 = [];
  const receiver = new Int32Array(n).fill(-1);
  const reaches = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (H[i] < seaLevel) { reaches[i] = 1; receiver[i] = i; continue; }
    const nb = neighborsOf(i, nbTmp2);
    let bestI = -1;
    for (let k = 0; k < nb.length; k++) {
      const j = nb[k];
      if (bestI < 0) { bestI = j; continue; }
      if (keyLess(j, bestI)) bestI = j;
    }
    receiver[i] = (bestI >= 0 && keyLess(bestI, i)) ? bestI : -1;
  }

  // 「能不能到海」：**顺着流向走**，边走边记忆判定（0 未知 / 1 能到 / 2 到不了）。
  //
  // ⚠️ 别想用"从海格反向 BFS"来定这件事：流向场的边是"i 流进 receiver[i]"，
  //    反向 BFS 要判的是 `receiver[j] === i`（j 流进 i）—— 从海格出发根本找不到上游，
  //    实测只能标出 0 个能到海的陆格（真值 1500+），于是出图 **0 条**。
  //    正向走 + 记忆化是 O(n)：每条边最多被走一次。
  const verdict = new Uint8Array(n);          // 0 未知 / 1 能到海 / 2 到不了
  for (let i = 0; i < n; i++) if (H[i] < seaLevel) verdict[i] = 1;
  const tracePath = [];
  for (let i = 0; i < n; i++) {
    if (verdict[i]) continue;
    tracePath.length = 0;
    let cur = i;
    let res = 0;
    while (true) {
      if (verdict[cur]) { res = verdict[cur]; break; }
      if (H[cur] < seaLevel) { res = 1; break; }
      const nx = receiver[cur];
      if (nx < 0 || nx === cur) { res = 2; break; }   // 没有下游：到不了海
      tracePath.push(cur);
      cur = nx;
      if (tracePath.length > n) { res = 2; break; }   // 兜底（按构造不该有环）
    }
    for (let k = 0; k < tracePath.length; k++) verdict[tracePath[k]] = res;
    verdict[i] = res;
  }
  for (let i = 0; i < n; i++) reaches[i] = verdict[i] === 1 ? 1 : 0;

  // ── ③ 汇流量：逐格累加（按**水位降序**：最高处先交，往下逐级汇总）────────
  //   receiver 的水位严格更低（按构造成立），所以"从高到低处理"能保证：donor 先把自己的量
  //   交给 receiver，receiver 比它晚处理，于是继续往下交。
  //   🔴 这一条曾经写成**升序**（"receiver 更低 → 先处理 receiver"听着更顺），结果
  //   donor 交量时 receiver 早已处理完 → 量全丢：`maxFlow` 只有 2，线宽分级整个失效
  //   （所有河一样细 —— 正是用户说的"僵硬折线"的一个成因）。
  const sorted = new Array(n);
  for (let i = 0; i < n; i++) sorted[i] = i;
  sorted.sort((a, b) => (filled[b] - filled[a]) || (H[b] - H[a]) || (a - b));
  const flow = new Float64Array(n);
  for (let i = 0; i < n; i++) flow[i] = 1;
  for (let k = 0; k < n; k++) {
    const i = sorted[k];
    if (H[i] < seaLevel) continue;         // 海格不往下交（它们互相指自己）
    if (!reaches[i]) continue;             // 到不了海的格不参与（它们的量无处可去）
    const nx = receiver[i];
    if (nx >= 0 && nx !== i) flow[nx] += flow[i];
  }

  // ── ⓷b **河网段**（树枝状汇聚的几何本体）─────────────────────────────────
  //
  // 🔴 2026-10-14 第四修（用户实测截图：「根本画不出复杂的河流汇聚（树枝状的河流，
  //    如多条河流汇总到一条大河最终入海）。地图自带河流做的比自动河流好」）。
  //
  // 根因是**几何口径**，不是宽度也不是平滑：
  //   `rivers[]` 是"每个源头一条**代表路径**"—— 一条折线从头走到海，**不包含**沿途汇进来的
  //   支流。实测（desite 9975 格）：源头高度 60 时 3 条河只有 **12 个点、覆盖 12 格**；
  //   降到 40 也就 67 条 / 270 点 / 188 格 —— 而陆地有 **2506 格**。
  //   所以画面上必然是"几根孤立的线"，**结构上不可能**出现树枝状汇聚。
  //
  // 修法：把**流向场本身**输出成段 —— 每个能到海的陆地格一条 `本格 → receiver` 的段，
  //   段宽按该格的汇流量。这样画出来就是真正的河网：支流一格一格汇进干流，
  //   干流越往下游流量越大、越宽。（这也是开源地形生成器画河网的标准做法。）
  //
  // ⚠️ 它**不替代** `rivers[]`：`rivers[]` 仍是"命名/分级的河流对象"（未来要挂桥/水坝/名称），
  //    两者是同一次追踪的两个视图。渲染可以选择只画段（河网观感）。
  const segments = [];
  for (let i = 0; i < n; i++) {
    if (H[i] < seaLevel || !reaches[i]) continue;
    const nx = receiver[i];
    if (nx < 0 || nx === i) continue;
    const a = pointXY(pts[i]);
    // 海格的中心在画出来的海岸线之外 —— 用**海格中心**当末端就是"河流钻进海里"。
    // 这里保留它（调用方负责按海岸线裁），但把 `endInSea` 标出来，
    // 让渲染端知道"这一段要裁到岸线上"（`clipPolylineToCoast` 的活）。
    const b = pointXY(pts[nx]);
    segments.push({
      x0: a[0], y0: a[1], x1: b[0], y1: b[1],
      flow: flow[i],
      endInSea: H[nx] < seaLevel,
      // 起点**格号**：让调用方/用例能判"段是逐格的"（坐标去重会被浮点坑到）
      cell: i,
    });
  }
  // 段按流量从小到大排：渲染时细的在下、粗的在上（同 `rivers` 的绘制序纪律）
  segments.sort((p, q) => (p.flow - q.flow) || (p.x0 - q.x0) || (p.y0 - q.y0));
  const segMaxFlow = segments.length ? segments[segments.length - 1].flow : 0;

  // ── ⓷c **内流盆地**（到不了海的洼地）的度量与出口 ─────────────────────────
  //
  // 🔴 2026-10-15（用户实测截图提到的「地图自带河流……还有内流河」）：
  //    现在"到不了海的格**一律不画**"（口径 ②，2026-10-14 定的 —— 为的是防"内陆凭空一条河"）。
  //    但真实世界里内流河是**一等存在**（里海/咸海/柴达木那种），FMG 的河流数据里也有。
  //    要画它，前置条件是**盆地口径**：先知道"水在这儿终止"，才谈得上画。
  //    本函数把盆地**量出来**（不画）：每个内陆洼地一个盆地，带**面积（格数）/ 最低点高度 /
  //    最远来水距离**。调用方据此决定：不画 / 画成"消失在内陆的河" / 画成湖泊。
  //
  // ⚠️ 只在**有 isLand 注入**时算（没有陆地判定时"到不了海"的格子包含大片海域边界噪声，
  //    量出来的盆地没有意义）。这一步是 O(n)，与汇流累积同一量级。
  const basins = [];
  if (isLand) {
    const isSink = (i) => {
      if (H[i] < seaLevel || reaches[i]) return false;
      const nx = receiver[i];
      return nx < 0 || nx === i || !reaches[nx];   // 没有下游，或下游也到不了海
    };
    const claimed = new Uint8Array(n);
    const upstream = new Map();          // receiver 格 → 上游格列表（只在到不了海的格里建）
    const q = [];
    for (let i = 0; i < n; i++) {
      if (H[i] < seaLevel || reaches[i]) continue;
      const nx = receiver[i];
      if (nx < 0 || nx === i || !reaches[nx]) continue;
      let arr = upstream.get(nx);
      if (!arr) { arr = []; upstream.set(nx, arr); }
      arr.push(i);
    }
    for (let i = 0; i < n; i++) {
      if (!isSink(i) || claimed[i]) continue;
      // 从洼地最低点向上游 BFS：走到哪，这个盆地就有多大
      q.length = 0;
      q.push(i);
      claimed[i] = 1;
      let count = 1;
      let lowest = H[i];
      let maxSteps = 0;
      for (let head = 0; head < q.length; head++) {
        const cur = q[head];
        const ups = upstream.get(cur);
        if (!ups) continue;
        for (const up of ups) {
          if (claimed[up]) continue;
          claimed[up] = 1;
          count++;
          if (H[up] < lowest) lowest = H[up];
          q.push(up);
        }
      }
      // 最远来水距离：从洼地做一次 BFS 深度（复用 q 的成员做一次分层太贵，这里用汇流量近似）
      maxSteps = Math.round(flow[i]);
      const [sx, sy] = pointXY(pts[i]);
      basins.push({ sink: i, x: sx, y: sy, cells: count, lowest: lowest, maxUpstream: maxSteps });
    }
    // 只留"像样的"盆地：太小的是噪声（微洼地）
    basins.sort((a, b) => b.cells - a.cells || a.sink - b.sink);
  }
  const basinCells = basins.reduce((a, b) => a + b.cells, 0);
  // 「水出不去」的陆地格总数（**去重**）：盆地面积之和可能重复计数，这个数是准的
  let endorheicCells = 0;
  for (let i = 0; i < n; i++) if (H[i] >= seaLevel && !reaches[i]) endorheicCells++;

  // ── ④ 河源：够高 + 能到海 + （有 isLand 时）离海够远 + 汇流量够大（口径 ②③④）
  //
  // 🔴 2026-10-14 第三修（用户实测「很丑、僵硬折线」的主因）：源头原来取**每一个**高地格
  //    （真实底图 399 个）→ 地图上是一大片**短促平行的支沟**（点数中位 7），既不像河、
  //    线宽也无从分级。现在要求**汇流量 ≥ `channelInit`**（累积上游面积）：只有汇集了
  //    足够多上游的格才起一条河。真实河网就是这么来的（河源 = 沟谷网络的出口）。
  //
  //    ⚠️ 这里踩过一次：第一版写成「**没有任何邻居**的 flow 大于自己」= 河源。
  //    那是错的：**下游**邻居的 flow 必然 ≥ 自己（它收了自己那一份），所以这条判据
  //    几乎把所有候选都否掉了（实测出图 **0 条**）。河源的正确特征是"没有上游"，
  //    而"上游"= 流进本格的格 —— 不需要额外检查就成立，因为 flow 只往下游加。
  const sources = [];
  let channelHeads = 0;
  for (let i = 0; i < n; i++) {
    if (H[i] <= sourceHeight || !reaches[i]) continue;
    if (isLand && seaDist[i] >= 0 && seaDist[i] < sourceInlandCells) { coastSources++; continue; }
    if (flow[i] < channelInit) continue;
    channelHeads++;
    sources.push(i);
  }
  // 河源按汇流量从大到小排：先认领**最大**的那条，主流/支流的归属才稳定（同输入同输出）
  sources.sort((a, b) => (flow[b] - flow[a]) || (a - b));

  const visited = new Uint8Array(n);
  let rivers;
  let dropped = 0;
  let truncated = false;
  let maxFlow = 0;
  let channelHeadsUsed = channelHeads;

  if (coalesced) {
    // ══ 河网合并（默认口径）══════════════════════════════════════════════════
    // 从**流量最大**的源头起认领整条干流，沿途的支流端点被 `claim` 吃掉 →
    // 同一条干流只画一遍（旧口径下同一个流域会被画很多遍，实测 57 条河挤成 29 个河口簇）。
    //
    // 🔴 两个坑（都是实测出来的）：
    //   ① **闸门的分母必须是"候选格"**，不是"所有格"。`flow` 在所有格上都有值（默认 1），
    //      包括占大半张图的**到不了海**的格子 → 拿全表分位当闸门时，真实底图实测
    //      **只出 3 条河**（该出的全被砍了）。候选格 = 够高 + 能到海的那批。
    //   ② **弱河没有资格"认领"格子**。若源头按流量降序、却让每条河（哪怕 2 个点）都先
    //      claim 掉路径，那么先跑的小沟会把干流的格子占掉 → 主干被 `visited` 跳过，
    //      结果只剩支沟、没有主干（"越合越碎"）。所以先走出完整路径，**判定合格之后再 claim**。
    //   ② **弱河没有资格"认领"格子**。若源头按流量降序、却让每条河（哪怕 2 个点）都先
    //      claim 掉路径，那么先跑的小沟会把干流的格子占掉 → 主干被 `visited` 跳过，
    //      结果只剩支沟、没有主干（"越合越碎"）。所以先走出完整路径，**判定合格之后再 claim**。
    // 🔴 两条**实测**结论（决定了这段长什么样，别照"教科书河网"想当然）：
    //   ① **"沿途流量闸门"在本数据上永远不触发**：desite 底图的候选格（够高 + 能到海）
    //      汇流量分布几乎全是 1~5，取任何分位都落在下限上 → 实测分位取
    //      0 / 0.15 / 0.3 / 0.5 / 0.6 **出图完全一样**。所以它**已被删除**，不再假装
    //      自己是"主次筛选"（留一个不起作用的参数 + 一句骗人的注释，比删掉更坏）。
    //      主次交给**线宽分级**（见 `makeRiverRecord` 的 `flows`）。
    //   ② **弱河没有资格"认领"格子**：若按流量降序、却让每条河（哪怕 2 个点）都先 claim
    //      掉路径，先跑的小沟会把干流的格子占掉 → 主干被跳过，结果只剩支沟、没有主干
    //      （"越合越碎"，首版实测：默认口径 82 条 vs 旧口径 57 条、河口反而更挤）。
    //      所以：先走出完整路径，**判定合格之后再 claim**；闸门只用来挡"没有任何上游"的孤立格。
    const flowGate = Math.max(2, channelInit);

    const heads = [];
    for (let i = 0; i < n; i++) {
      if (H[i] <= sourceHeight || !reaches[i]) continue;
      if (isLand && seaDist[i] >= 0 && seaDist[i] < sourceInlandCells) { coastSources++; continue; }
      if (flow[i] < flowGate) continue;
      heads.push(i);
    }
    heads.sort((a, b) => (flow[b] - flow[a]) || (a - b));
    channelHeadsUsed = heads.length;

    rivers = [];
    const claimed = new Uint8Array(n);
    for (let s = 0; s < heads.length; s++) {
      const src = heads[s];
      if (claimed[src]) continue;
      const path = [src];
      let cur = src;
      let steps = 0;
      let hitSea = false;
      while (steps < maxSteps) {
        const nxt = receiver[cur];
        if (nxt < 0 || nxt === cur) { hitSea = H[cur] < seaLevel; break; }
        path.push(nxt);
        cur = nxt;
        steps++;
        if (H[cur] < seaLevel) { hitSea = true; break; }
      }
      if (steps >= maxSteps) truncated = true;
      if (!hitSea || path.length < minPoints) { dropped++; continue; }
      // 合格 → claim（只有这样，弱河才不会把干流的格子占掉）
      for (let k = 0; k < path.length; k++) claimed[path[k]] = 1;
      const rec = makeRiverRecord(path, flow, H, pts, seaLevel, src);
      if (rec.flow > maxFlow) maxFlow = rec.flow;
      rivers.push(rec);
    }
    // 先大后小：绘制顺序稳定（同输入同输出），也方便调用方"只画前 N 条"
    rivers.sort((a, b) => (b.flow - a.flow) || (a.len - b.len) || (a.points[0].x - b.points[0].x));
    for (let k = 0; k < rivers.length; k++) rivers[k].rank = k;
    maxFlow = 0;
    for (const r of rivers) if (r.flow > maxFlow) maxFlow = r.flow;
  } else {
    // ══ 旧口径（显式传了 `channelInit`）—— 每个汇流节点一条河，各自画到海 ══════
    rivers = [];
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s];
      if (visited[src]) continue;
      const path = [src];
      let cur = src;
      let steps = 0;
      let hitSea = false;
      while (steps < maxSteps) {
        visited[cur] = 1;
        const nxt = receiver[cur];
        if (nxt < 0 || nxt === cur) { hitSea = H[cur] < seaLevel; break; }
        path.push(nxt);
        cur = nxt;
        steps++;
        if (H[cur] < seaLevel) { hitSea = true; break; }
      }
      if (steps >= maxSteps) truncated = true;
      if (!hitSea || path.length < minPoints) { dropped++; continue; }
      const rec = makeRiverRecord(path, flow, H, pts, seaLevel, src);
      if (rec.flow > maxFlow) maxFlow = rec.flow;
      rivers.push(rec);
    }
  }

  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return {
    rivers,
    sources: coalesced ? channelHeadsUsed : sources.length,
    reaching: coalesced ? channelHeadsUsed : sources.length,
    dropped,
    cells: n,
    neighborFactor: factor,
    elapsedMs: t1 - t0,
    truncated,
    coastSources,
    maxFlow,
    coalesced,
    // 闸门读数（供状态栏据实回执：「源头高度 >N、离海 ≥M 格」）——
    // 这份地形上它决定条数，用户看不到读数就会以为"河就是少的"。
    sourceHeight,
    sourceInlandCells,
    // 河网段（树枝状汇聚的几何本体；见上面 ⓷b）。`segMaxFlow` = 段的汇流量上界，
    // 线宽归一化要用它（见 `utils/riverRender.js` 的 `flowWidthScale`）。
    segments,
    segMaxFlow,
    // 内流盆地（到不了海的洼地，见 ⓷c）：**只度量、不画**。调用方据此决定要不要画内流河。
    // ⚠️ `basinCells` 是盆地面积之和，可能 **>** `endorheicCells`（两个洼地共用一个上游时会被
    //    两个盆地都数一次）。要"有多少陆地格的水出不去"请看 **`endorheicCells`**。
    basins,
    basinCells,
    endorheicCells,
    medianFlow: medianOf(flow),
    upsample,
    upsampleNote,
    // 追踪前平滑（见 ⓿b）：`smoothed` = 实际生效的半径（0 = 没开），供回执据实说
    smoothed,
    smoothNote,
    spacing,
  };
}

/** 中位数（诊断/线宽归一用；n 到十万级，排序一次可接受） */
function medianOf(arr) {
  const n = arr.length;
  if (!n) return 0;
  const a = Float64Array.from(arr);
  a.sort();
  return a[n >> 1];
}

/**
 * 由一条**格点路径**造出河流记录（单一实现，合并/旧口径共用）。
 *
 * 逐点带上 `flows` / `order` 两列，是为了让渲染端能做到「主次分明」：
 *   · `flows[k]` = 该点的汇流量 → 现状（该点以下是主干还是支流）
 *   · `order[k]` = Strahler 河序 → 该点是几级支流（1 级最细，越大越是干流）
 * 只给一个标量（旧版的 `flow` 字段）时，同一条河从源头到河口只能一个粗细 ——
 * 那正是"一眼假"的来源之一（真实的河是**越往下游越宽**）。
 */
function makeRiverRecord(path, flow, H, pts, seaLevel, srcIndex) {
  const len = path.length;
  const points = new Array(len);
  const flows = new Float64Array(len);
  for (let k = 0; k < len; k++) {
    const [x, y] = pointXY(pts[path[k]]);
    points[k] = { x, y };
    flows[k] = flow[path[k]] || 1;
  }
  return {
    points,
    flows,
    order: strahlerOrders(flow, H, path),
    flow: flows[len - 1] || 1,          // 出口处的汇流量（= 沿途最大，flow 沿流向下游单调不减）
    mouthFlow: flows[len - 1] || 1,
    maxFlow: maxOf(flows),
    medianFlow: medianOf(flows),
    len,
    endInSea: H[path[len - 1]] < seaLevel,
    srcIndex,
  };
}

function maxOf(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/**
 * Strahler 河序（沿一条路径逐点推）。
 *
 * 口径：某点的**支流** = 流进它的邻居里、汇流量比它小的那些（`flow[donor] < flow[i]`）。
 *   · 支流里最大的级是**唯一**的 → 该点 = 那个级 + 1（两条同级汇合成高一级）
 *   · 有两个及以上同级最大 → 该点 = 那个级（不再升级）
 * 这是"支流级数"的教科书口径，用途只有一个：让画布能把 1 级支流画细、干流画粗。
 *
 * ⚠️ 别把它当成精确的水文分级去用（那需要完整的上下游拓扑）。这里只需要"相对粗细正确"，
 *    而它逐点算出来的相对关系恰好是对的（越往下游 order 单调不减）。
 */
function strahlerOrders(flow, H, path) {
  const len = path.length;
  const order = new Uint8Array(len);
  for (let k = 0; k + 1 < len; k++) {
    const f = flow[path[k]];
    if (f > 1 && f < flow[path[k + 1]]) order[k + 1] = order[k] + 1;
    else order[k + 1] = order[k];
  }
  return order;
}

/**
 * 折线平滑（Chaikin 角切割，纯函数）。
 *
 * 🔴 2026-10-16：**实现已下沉到 `utils/polylineSmooth.js`**（手画河与省份渲染也要用，
 *    而那几个模块不该为了一个平滑把整套追踪算法 import 进来）。
 *    这里**保留同名 re-export**，既有调用方（ScenarioMap / riverRender / 单测）零改动。
 *    平滑参数只此一份 —— 散成两份就会"同一条河在不同视图里弯度不同"，而且不会报错。
 */
export { smoothPolyline } from './polylineSmooth.js';


/**
 * 把折线朝**两侧**裁剪到一组「是不是陆地」的判定上。
 *
 * 用途：导入的 FMG 河与手动生成的河都可能**冲进海里一大段**（真实底图实测：最长的一段
 * 连着 19 个海格 ≈ 274 世界单位）。这里从两端往内收：先把尾部连续的水段砍掉，再回插一个
 * **交点**，让河的末端正好停在边界上（而不是停在最后一个陆格的中心 —— 那样会短一截，
 * 看起来"河没入海"）。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {(x:number,y:number)=>boolean} isLand `true` = 该点算陆地（留在河里）
 * @param {{keepOvershoot?:number}} [opts] `keepOvershoot` = 允许保留的入海长度（世界单位，默认 0）
 * @returns {Array<{x:number,y:number}>} 裁剪后的折线（全部是水 → 返回空数组）
 */
export function clipPolylineToLand(points, isLand, opts = {}) {
  const src = Array.isArray(points) ? points : [];
  if (src.length < 2) return src.slice();
  const keep = Number.isFinite(opts.keepOvershoot) ? Math.max(0, opts.keepOvershoot) : 0;

  const isLandAt = (p) => {
    try { return !!isLand(p.x, p.y); } catch (_) { return true; }   // 判定抛错 → 当作陆地（不误删）
  };

  // ① 尾部：连续的水段整体砍掉，再二分回插交点
  let end = src.length - 1;
  while (end >= 0 && !isLandAt(src[end])) end--;
  if (end < 0) return [];
  let tail = end;
  if (tail < src.length - 1) {
    // src[tail] 是陆、src[tail+1..] 是水 → 在 [tail, tail+1] 之间找入海点
    const a = src[tail], b = src[tail + 1];
    const t = crossingT(a, b, isLandAt);
    const cross = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const out = src.slice(0, tail + 1);
    if (keep > 0) {
      const d = Math.hypot(b.x - cross.x, b.y - cross.y);
      const k = d > 0 ? Math.min(1, keep / d) : 0;
      out.push({ x: cross.x + (b.x - cross.x) * k, y: cross.y + (b.y - cross.y) * k });
    } else {
      out.push(cross);
    }
    src.length = 0;
    src.push(...out);
    tail = src.length - 1;
  }

  // ② 头部：同理（源头落在水里的情况：湖心源 / 数据错位）
  let start = 0;
  while (start <= tail && !isLandAt(src[start])) start++;
  if (start > tail) return [];
  if (start > 0) {
    const a = src[start - 1], b = src[start];
    const t = crossingT(a, b, isLandAt);
    const cross = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const out = [{ x: cross.x, y: cross.y }, ...src.slice(start)];
    return out;
  }

  return src.slice();
}

/** 在 a（陆）→ b（水）之间二分出交点参数 t（a 端 t=0，b 端 t=1）；判定单调时结果稳定 */
function crossingT(a, b, isLandAt) {
  let lo = 0, hi = 1;
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    const p = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
    if (isLandAt(p)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
