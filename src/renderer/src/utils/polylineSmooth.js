// utils/polylineSmooth.js — **折线平滑 / 抽稀**的唯一实现（纯函数，Node 可测；2026-10-16）
//
// ── 为什么要单独一个模块 ─────────────────────────────────────────────────────
// Chaikin 角切割原先只住在 `utils/riverTrace.js` 里（`smoothPolyline`）。但手画河
// （两张画布：行星图 + 剧本底图）也需要它 —— 而 `provinceShape.js` 是**省份渲染热路径**
// （21 省 × 数千点逐帧），如果为了一行平滑去 `import riverTrace`，就等于把整套**追踪算法**
// 拖进渲染路径（首帧成本 + 循环依赖风险）。
//
// 所以把这两个纯几何函数**下沉**到本模块：
//   · `riverTrace` 从这里 import 并**继续 re-export**（对外 API 不变，既有调用方零改动）；
//   · `provinceShape` / 两个画布从这里 import。
// ⚠️ 关键是**只有一份实现** —— 平滑参数（1/4、3/4）散成两份就会"同一条河在不同视图里弯度不同"，
//    而这种偏差**不会报错**，只会让人"总觉得哪里不对"（本项目反复踩过的那类）。

/**
 * 折线平滑（Chaikin 角切割，纯函数）。
 *
 * 为什么需要：追踪出来的点是**格心**，一格一跳 → 画出来是一串硬折角（真实底图实测
 * **转角中位数 41.6°**、最大 113°）；手画笔迹同理。Chaikin 在每段上取
 * 1/4 与 3/4 两点替换原顶点：**只切角、不外扩**（不像 Catmull-Rom 会在窄谷处过冲），
 * 端点保持不动，所以河口/源头位置一字不差。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} [iterations] 迭代次数（1 次 = 每段变 2 段；2 最常用）
 * @returns {Array<{x:number,y:number}>} 新数组（不改入参）
 */
export function smoothPolyline(points, iterations = 2) {
  let src = Array.isArray(points) ? points.slice() : [];
  const it = Number.isFinite(iterations) ? Math.max(0, Math.min(4, iterations)) : 2;
  if (src.length < 3 || it === 0) return src;
  for (let round = 0; round < it; round++) {
    const out = [src[0]];
    for (let i = 0; i + 1 < src.length; i++) {
      const a = src[i], b = src[i + 1];
      out.push({ x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25 });
      out.push({ x: a.x + (b.x - a.x) * 0.75, y: a.y + (b.y - a.y) * 0.75 });
    }
    out.push(src[src.length - 1]);
    src = out;
  }
  return src;
}

/**
 * 笔迹抽稀：丢掉离**上一个保留点**太近的采样点。
 *
 * 为什么必须有：自由拖笔时 pointermove 每几像素报一次，一路 push 下去
 * 一条长河会攒出**上千个节点**（节点编辑不可用、项目 JSON 也白胖）。
 * 按世界单位设最小间距，是"流畅笔迹"与"可编辑"之间的平衡点。
 * 端点必留，否则河头/河口会被抽掉。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} minDist 最小间距（世界单位）
 */
export function decimatePolyline(points, minDist) {
  const src = Array.isArray(points) ? points : [];
  if (src.length <= 2) return src.slice();
  const d = Number.isFinite(minDist) && minDist > 0 ? minDist : 0;
  if (!d) return src.slice();
  const out = [src[0]];
  for (let i = 1; i < src.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(src[i].x - last.x, src[i].y - last.y) >= d) out.push(src[i]);
  }
  const tail = src[src.length - 1];
  const last = out[out.length - 1];
  if (Math.hypot(tail.x - last.x, tail.y - last.y) < 1e-9) out[out.length - 1] = tail;
  else out.push(tail);
  return out;
}

/**
 * **画的时候就能看到的**平滑（笔迹预览专用；两张画布共用）。
 *
 * 为什么需要（用户反馈「画的时候看不到平滑」）：
 *   抬笔那一刻才跑 Chaikin 的话，**笔迹预览整个过程都是硬折线** ——
 *   用户按他看到的折线判断"这条河好不好看"，然后一松手形状突然变了。
 *   预览与落库必须是同一种曲线。
 *
 * 🔴 为什么只平滑**尾部**而不是整条：
 *   ① 成本：pointermove 每几像素一次，整条平滑是 O(迭代 × 全点数) 的重复计算；
 *   ② 更要紧的是**稳定性** —— 整条重算时，前面那些"已经画完"的点每次都会再挪一点，
 *      观感是"我画过的部分在蠕动"。尾部窗口一旦被推出窗口就**定格**，
 *      所以越画越稳、只有笔尖附近在弯。
 *
 * ⚠️ 这只是**显示**：落库仍走 `smoothRiverNodes` 对最终笔迹做整条平滑。
 *    返回新数组，不改入参。
 *
 * @param {Array<{x:number,y:number,h?:number}>} nodes 原始笔迹（追加顺序）
 * @param {number} [iterations] 落地默认 2（与落库口径一致）
 * @param {number} [tailLen] 参与平滑的尾部点数
 */
export function smoothWhileDrawing(nodes, iterations = 2, tailLen = 12) {
  const src = Array.isArray(nodes) ? nodes : [];
  const n = Math.max(4, Number.isFinite(tailLen) ? tailLen : 12);
  if (src.length < 4) return src.map((p) => ({ ...p }));
  const keep = Math.max(0, src.length - n);
  // 交接点也留在窗口里：否则平滑段与稳定段之间会出现一个**没人切过的角**
  const from = keep > 0 ? keep - 1 : 0;
  const head = src.slice(0, from).map((p) => ({ ...p }));
  const tail = smoothRiverNodes(src.slice(from), iterations);
  return head.concat(tail);
}

/**
 * 把折线**压到目标点数**（按弧长均匀取样，端点必留）—— 纯函数。
 *
 * 🔴 为什么必须有它（2026-10-17，用户截图实测：手画河渲染成"一串点"）：
 *    一条河的点数**不能由用户的拖动时长决定**。旧实现是「按最小间距抽稀 → Chaikin 迭代 2 轮」，
 *    而 Chaikin 每轮把点数乘 2、减 1 —— 一条 300 点的笔迹平滑完是 **~1197 点**，
 *    而画布上只有 ~700 屏幕像素宽 → 节点间距 < 1px →
 *    **节点手柄糊成一条虚线**（用户看到的"一堆点，而不是线"）。
 *
 * 口径：目标点数由调用方按**弧长 / 期望间距**给，再夹到 [minCount, maxCount]。
 * 这样**长河多给点、短河少给点**，而"每像素几个点"这种病态密度被结构性地排除。
 *
 * ⚠️ 不引入新几何（只**挑**原点），端点逐字保留。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} targetCount 期望点数
 * @param {{minCount?:number, maxCount?:number}} [opts]
 */
export function fitPolylineToCount(points, targetCount, opts = {}) {
  const src = Array.isArray(points) ? points : [];
  if (src.length <= 2) return src.map((p) => ({ ...p }));

  // ① 先量总弧长 —— **判"退化"必须先于判"要多少点"**：
  //    3 个坐标完全相同的点，弧长是 0，此时"压到 2 点"和"原样返回"长得一样，
  //    但语义完全不同（前者是"这条河只有一个位置"，后者是"这条河有三个拐点"）。
  //    ⚠️ 我第一版把 `want >= src.length → 原样返回` 放在了前面，
  //       于是 3 个重合点直接原样返回 3 个同坐标点 = **一串点**（正是要根治的病）。
  const cum = [0];
  for (let i = 0; i + 1 < src.length; i++) {
    cum.push(cum[i] + Math.hypot(src[i + 1].x - src[i].x, src[i + 1].y - src[i].y));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [src[0], src[src.length - 1]].map((p) => ({ ...p }));

  const minC = Math.max(2, Math.floor(Number.isFinite(opts.minCount) ? opts.minCount : 4));
  const maxC = Math.max(minC, Math.floor(Number.isFinite(opts.maxCount) ? opts.maxCount : 256));
  const want = Math.max(minC, Math.min(maxC, Math.round(Number.isFinite(targetCount) ? targetCount : src.length)));
  if (want >= src.length) return src.map((p) => ({ ...p }));

  const out = [{ ...src[0] }];
  let seg = 1;
  for (let k = 1; k < want - 1; k++) {
    const target = (total * k) / (want - 1);
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const a = seg - 1, b = seg;
    const span = cum[b] - cum[a];
    const t = span > 1e-12 ? (target - cum[a]) / span : 0;
    // 原始点若带别的字段（如 h），按**该段的起点**带过去 —— 不凭空造值
    const extra = {};
    for (const kk of Object.keys(src[a])) {
      if (kk !== 'x' && kk !== 'y') extra[kk] = src[a][kk];
    }
    out.push({ x: src[a].x + (src[b].x - src[a].x) * t, y: src[a].y + (src[b].y - src[a].y) * t, ...extra });
  }
  out.push({ ...src[src.length - 1] });
  return out;
}

/**
 * 带高度的折线平滑（**手画河节点**专用；两张画布共用）。
 *
 * ⚠️ 高度必须跟着点走：`smoothPolyline` 只处理 `{x,y}`，若把结果直接当河流节点，
 *    新的中间点会**没有 h** → 「从高到低」的流向不变量没法维持。
 *    这里给平滑后的每个点取**最近原点**的 h（比按折线参数插值简单，且不会跨段串味）。
 * ⚠️ 首末点的 h **逐字保留** —— 源头/河口的海拔是用户看得见的读数。
 * 🔴 **一个点都没有 h 时，输出里也不该有 h**（2026-10-17 修）：
 *    原来无条件补 `h: 0`，而**剧本底图的河存的是 `{x,y}`、根本没有海拔** ——
 *    于是每存一条底图河都会往项目文件里塞几百个 `"h":0`（体积 + 一个"有海拔"的假信号）。
 *    判断口径按"输入里任何一点有有限 h"来定，与下面 `hasH` 同一来源。
 *
 * @param {Array<{x:number,y:number,h?:number}>} nodes
 * @param {number} [iterations]
 */
export function smoothRiverNodes(nodes, iterations = 2) {
  const src = Array.isArray(nodes) ? nodes : [];
  if (src.length < 3) return src.map((p) => ({ ...p }));
  const sm = smoothPolyline(src, iterations);
  const hasH = src.some((p) => Number.isFinite(p.h));
  // 没有海拔概念的数据（底图河）：只带坐标，**不伪造 h**
  if (!hasH) return sm.map((p) => ({ x: p.x, y: p.y }));
  const out = [];
  for (const p of sm) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < src.length; i++) {
      const d = Math.hypot(src[i].x - p.x, src[i].y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    out.push({ x: p.x, y: p.y, h: Number.isFinite(src[best].h) ? src[best].h : 0 });
  }
  if (Number.isFinite(src[0].h)) out[0].h = src[0].h;
  if (Number.isFinite(src[src.length - 1].h)) out[out.length - 1].h = src[src.length - 1].h;
  return out;
}
