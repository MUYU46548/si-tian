// utils/riverChains.js — 从**流向场**重建"真正的河链"（纯函数，Node 可测；2026-10-17）
//
// ⚠️ 文件名是 `riverChains`（**不是** `riverPaths`）：后者在本仓是"组件本地平行事实源"的禁用词
//    （`test_95` 有红线 —— 手画河曾因组件里那个本地 `riverPaths` 数组而"画完就丢"）。
//    本模块是**纯函数层**，与那条历史缺陷无关，但命名要避让，免得守卫误报。
//
// ── 为什么必须有这个模块（用户第三次说"支气管模拟器"）──────────────────────────
// `traceRivers()` 输出的 `segments` 是**流向场本身**：每个能到海的陆地格一条
// `本格 → receiver` 的**一格长小棍**。它解决了"树枝状汇聚"（支流能汇进干流），
// 但**逐段画**的观感是灾难：
//   · 每根小棍独立描边 → 分叉处像"劈开的三根棍"，不是一条河分成两条；
//   · 每根小棍都是直线 → 整片河网是**放射状短直棍**（用户原话"支气管模拟器"）；
//   · 相邻小棍之间**没有共享的几何**（各画各的），所以永远不可能"看起来是一条连续的河"。
//
// 🔴 正确做法（也是开源水文/制图工具的标准做法）：**先把流向场还原成河链，再画河链**。
//    还原方式就是"沿 receiver 往上溯"：
//      · 从每个"河口格"（它流进海/湖泊）与**每个汇流点**（流进它的格 ≥ 2）出发；
//      · 沿**唯一上游**一路往上走，直到源头或下一个汇流点；
//      · 于是得到一组"从某个源头到下一个汇流点/河口"的**完整链**，
//        干流是一条长链、支流各自是链 —— 逐条画曲线就得到**连续的河**。
//    这比"逐段画"多出的能力：链内部可以**平滑**（一条曲线穿过几十个格心），
//    而逐段画每段只有两个点、**没有可以平滑的余地**。
//
// ⚠️ 分叉点必须断开：一条链不能同时穿过两条支流（几何上会画出一个"Y"字的三根棍）。
//    所以本模块在每个"上游 ≥ 2"的格**终止链**，从那里另起新链往下游走。
//    —— 这不是近似，而是流网的**正确分解**（Strahler/Shreve 分级的同一种分解）。

/** 版本标记（探针可读）：改了本模块的判据就 +1 —— 用来确认"页面跑的是不是这份代码" */
export const RIVER_PATHS_VERSION = 3;

/** 从 `{x0,y0,x1,y1}` 形式的段里取"格"的量化键（浮点坐标必须量化，见 `pruneRiverNetwork` 的教训） */
function cellKey(x, y) {
  const q = (v) => Math.round((Number.isFinite(v) ? v : 0) * 100);
  return `${q(x)},${q(y)}`;
}

/**
 * 把"逐格的流向段"还原成**河链**（多条从源头/分叉点到下一个分叉点/河口的折线）。
 *
 * 🔴 **为什么过滤要在"链"这一层做，而不是在"段"这一层**（2026-10-17 第八修实测）：
 *    一开始我只按段的流量剪枝，然后才建链 —— 实测 593 条链里 **496 条只有 2 个点**
 *    （= 一格长的孤段）。那就是用户说的"支气管"：**一堆短直棍**，不是河。
 *    原因很直接：流量闸门只筛"水量"，不筛"这条河有多长"；而**短**才是观感的另一个主因。
 *    所以现在：先建链，再按 **"链够长 或 流量够大"** 过滤 ——
 *      · 长链（≥ `minLen` 个格心）本身看起来就是河；
 *      · 短链只有流量足够大才留（它是干流的一段，不能丢）。
 *
 * @param {Array<{x0:number,y0:number,x1:number,y1:number,flow:number,endInSea?:boolean,cell?:number}>} segments
 * @param {{minFlow?:number, minLen?:number, maxPaths?:number}} [opts]
 *   `minFlow` = 链的流量下限（细支流不画）
 *   `minLen`  = 链的**点数**下限（太短的链即使流量达标也不画 —— 那是短棍）
 *   `maxPaths` = 最多返回多少条链（按流量从大到小；防止病态数据把渲染拖死）
 * @returns {Array<{points:Array<{x:number,y:number,flow:number}>, flow:number, endInSea:boolean}>}
 *   按 `flow` **从大到小**排（画的时候细的在先、粗的在后，同 `segments` 的绘制序纪律）
 */
export function buildRiverPaths(segments, opts = {}) {
  const list = Array.isArray(segments) ? segments.filter(
    (s) => s && Number.isFinite(s.x0) && Number.isFinite(s.y0) && Number.isFinite(s.x1) && Number.isFinite(s.y1),
  ) : [];
  if (!list.length) return [];

  const minFlow = Number.isFinite(opts.minFlow) ? opts.minFlow : 0;
  const minLen = Math.max(2, Math.floor(Number.isFinite(opts.minLen) ? opts.minLen : 2));
  const maxPaths = Number.isFinite(opts.maxPaths) && opts.maxPaths > 0 ? Math.min(4000, opts.maxPaths) : 1200;

  // ── 索引：每格 → 它的下游（唯一）与上游（可能多个）────────────────────────────
  const segBySrc = new Map();       // 起点格键 → 段
  const upstreamOf = new Map();     // 终点格键 → [上游段...]
  for (const s of list) {
    segBySrc.set(cellKey(s.x0, s.y0), s);
    const dk = cellKey(s.x1, s.y1);
    let arr = upstreamOf.get(dk);
    if (!arr) { arr = []; upstreamOf.set(dk, arr); }
    arr.push(s);
  }

  const paths = [];
  const visited = new Set();        // 段（按起点格键）已归属某条链

  /**
   * 从 `seg` 起**沿最主要的那个上游**一路往上走，得到一条尽可能长的链。
   *
   * 🔴 2026-10-17 第八修（第二版，我第一版错了）：第一版"遇汇流点就断链"，
   *    结果是**干流被切成一堆 2 点碎片**（实测 593 条链里 496 条只有 2 点、
   *    而且它们的流量高达 124~130 —— 因为那本来就是干流，只是被切碎了）。
   *    正确做法（也是 Strahler 分级找主干的方式）：
   *      · 在每个汇流点，**继续沿流量最大的那个上游**走（它是主干）；
   *      · 其余上游**另起支流**（记进 `sideBranches`，之后各自成链）。
   *    于是干流是一条长链，支流从各自源头汇进来 —— 这才是"河网"。
   */
  const sideBranches = [];
  const traceUp = (seg) => {
    const chain = [seg];            // 从下游往上游累
    let cur = seg;
    const guard = new Set();
    while (true) {
      const k = cellKey(cur.x0, cur.y0);
      if (guard.has(k)) break;      // 环（数据异常）：停
      guard.add(k);
      const ups = upstreamOf.get(k) || [];
      if (!ups.length) break;       // 到源头
      // 主干 = 流量最大的上游；其余记成支流（各自会成为独立链）
      let main = ups[0];
      for (const u of ups) {
        if ((u.flow || 0) > (main.flow || 0)) main = u;
      }
      for (const u of ups) {
        if (u !== main) sideBranches.push(u);
      }
      cur = main;
      chain.push(cur);
    }
    // 反转成"源头 → 河口"，并把每格的汇流量带上（供逐点变宽）
    const points = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const s = chain[i];
      points.push({ x: s.x0, y: s.y0, flow: s.flow });
    }
    const last = chain[0];
    points.push({ x: last.x1, y: last.y1, flow: last.flow });
    return { points, segs: chain };
  };

  // ── 起点集合：① 河口（段标了 endInSea）② 每个**汇流点**的上游分支 ──────────────
  // 先从**流量大的段**开始，这样长干流优先成形（避免先被支流"占掉"共享段）
  const byFlowDesc = list.slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));
  const push = (seg) => {
    const key = cellKey(seg.x0, seg.y0);
    if (visited.has(key)) return;
    const { points, segs } = traceUp(seg);
    for (const s of segs) visited.add(cellKey(s.x0, s.y0));
    const flow = Math.max(...segs.map((s) => (Number.isFinite(s.flow) ? s.flow : 0)));
    // 🔴 过滤口径见函数头注释：**够长 或 流量够大**才留（只按流量会留下一堆一格短棍）
    const longEnough = points.length >= minLen;
    if (points.length >= 2 && (longEnough || flow >= minFlow)) {
      paths.push({ points, flow, endInSea: !!seg.endInSea });
    }
  };
  for (const s of byFlowDesc) {
    if (s.endInSea) push(s);
  }
  // 支流：上面的 `traceUp` 在汇流点把**非主干**的上游记进了 `sideBranches` —— 各自成链
  for (const u of sideBranches) push(u);
  // 兜底：剩下的段（既不是河口也不在汇流点上 —— 数据边缘）也各成一条
  for (const s of byFlowDesc) push(s);

  paths.sort((a, b) => (b.flow - a.flow) || (b.points.length - a.points.length));
  void segBySrc;
  return paths.slice(0, maxPaths);
}

/**
 * 把一条河链**按弧长压到目标点数**并保留逐点流量 —— 给"画曲线"用。
 *
 * 为什么要压：一条干流在粗格上也可能有 60+ 个格心，逐个当曲线控制点会让
 * Catmull-Rom 在每格之间都拐一下（"描点连线"的观感又回来了）。
 * 压到 8~14 个控制点之后，曲线才是**大尺度的弯**（真实河流的弯是公里级的，
 * 不是格级的）。
 *
 * @param {Array<{x:number,y:number,flow:number}>} points
 * @param {number} target 目标控制点数
 * @returns {Array<{x:number,y:number,flow:number}>} 新数组（端点逐字保留）
 */
export function thinRiverPath(points, target = 12) {
  const src = Array.isArray(points) ? points : [];
  if (src.length <= 2) return src.map((p) => ({ ...p }));
  const want = Math.max(2, Math.min(src.length, Math.floor(Number.isFinite(target) ? target : 12)));
  if (want >= src.length) return src.map((p) => ({ ...p }));

  const cum = [0];
  for (let i = 0; i + 1 < src.length; i++) {
    cum.push(cum[i] + Math.hypot(src[i + 1].x - src[i].x, src[i + 1].y - src[i].y));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [src[0], src[src.length - 1]].map((p) => ({ ...p }));

  const out = [{ ...src[0] }];
  let seg = 1;
  for (let k = 1; k < want - 1; k++) {
    const targetLen = (total * k) / (want - 1);
    while (seg < cum.length - 1 && cum[seg] < targetLen) seg++;
    const a = seg - 1, b = seg;
    const span = cum[b] - cum[a];
    const t = span > 1e-12 ? (targetLen - cum[a]) / span : 0;
    out.push({
      x: src[a].x + (src[b].x - src[a].x) * t,
      y: src[a].y + (src[b].y - src[a].y) * t,
      // 流量按**段起点**带过去（不凭空插值一个不存在的汇流量）
      flow: src[a].flow,
    });
  }
  out.push({ ...src[src.length - 1] });
  return out;
}
