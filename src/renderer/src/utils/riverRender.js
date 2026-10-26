// utils/riverRender.js — 河流**画法**的唯一实现（纯函数 + 一个 canvas 绘制助手；2026-10-14）
//
// ── 为什么抽出来 ─────────────────────────────────────────────────────────────
// 「自动河流很丑、是僵硬的折线」这条反馈的最后一块拼图是**画法**：追踪出来的折线就算位置对，
// 只要**从源头到河口一个粗细**、或者**一条河只描一道线**，看上去就还是"假的"。
//
// 真实河网在人眼里的三个特征，本模块逐一对应：
//   ① **从源头到河口越来越宽** → `flows[]` 逐点汇流量 → `riverWidthAt()`；
//   ② **支流细、干流粗、汇合处自然过渡** → 逐点宽度 + 相邻点取平均再描（见 `strokeRiver`）；
//   ③ **河流要"压"在地形上** → 两遍描边（外层浅色描边 + 内层亮芯），一条 1px 的实线
//      在花掉的地形上根本认不出来。
//
// ⚠️ 三处都画河（剧本底图的导入河 / 手画河、行星图的河）**必须共用本模块的
//    `RIVER_STROKE` 与 `riverWidthAt`** —— 各写一套 = 同一份数据在不同视图里粗细不同、
//    颜色也不一致，而这种不一致**不会报错**，只会让人"总觉得哪里不对"。
//
// 本模块只做几何与画法：不写盘、不走 undo、不碰 store。

import { RIVER_COLOR } from './rivers.js';

/** 河水的**描边色**（画布渲染用）。
 *  🔴 2026-10-14 第四修（用户实测截图：「甚至有色差（与地图自带河流相差明显）」）：
 *  原来这里是自选的 `#4f93b8`，而地图上**已有的**河流是三个不同的蓝：
 *    · `utils/rivers.js` 的 `RIVER_COLOR = '#3B82F6'`（手画河 / 数据的默认色）
 *    · `ScenarioMap.drawRiverPaths` 写的 `#5d97bb`（手画河的实际描边色）
 *    · FMG 导入河按数据里的 `color`
 *  于是同一个画面上有三种蓝 —— 一眼就"不是一套东西"。现在**自动河流的同色**对齐
 *  `RIVER_COLOR`（最亮、最饱和的那个，也是"自带河流"给人的印象色）。
 *  ⚠️ 手画河 / 导入河各自按自己的数据画，本轮**没有**统一它们（那是另一件事：
 *  统一就要动用户已存数据里的颜色，属于数据变更，不在"画法"范围内）。 */
export const RIVER_STROKE = RIVER_COLOR;

/** 亮芯色（两遍描边的内层；比描边色亮一档，做"水面反光"的观感）。
 *  ⚠️ 只用在高光上、alpha 很低：颜色太亮会与描边色分开成"两种蓝"，又回到色差问题。 */
export const RIVER_CORE = '#93c5fd';

// ── 与「地图自带河流」对齐的画法（2026-10-16 第五修，用户实测） ────────────────
//
// 🔴 用户第三次报：「自动河流依旧色差、依旧和底图自带河流各画各的」。上一轮我把自动河的
//    颜色对齐到 `RIVER_COLOR = '#3B82F6'` 就以为解决了 —— **那是手画河写进数据里的默认色，
//    不是地图上真正画出来的那条自带河**。实测真实底图（desite）：
//      · 自带河（FMG 导入）：单遍实线 `#5d97bb`，屏幕线宽 **p50 = 0.70px**、max 2.55px
//      · 自动河（上一轮）：外层 `#3B82F6` @alpha0.35 宽 ×2.4 + 内层亮芯 `#93c5fd`
//        → zoom=1 时 p50 = **0.80px 实心 + 1.92px 光晕**
//    于是自动河整片是"发光的中蓝色带子"，自带河是"贴着地形的细暗线" —— 同屏一眼就是两套东西。
//
// 🔴 **可复用的判据**：对齐"观感"要对齐**屏幕上实际画出来的那条线**（色值 + 线宽量纲 +
//    几遍描边），不是对齐"数据里存的默认值"。数据里那个 `RIVER_COLOR` 从来没被画出来过。
//
// ⚠️ 这两个量只跟**屏幕像素**有关（自带河就是按屏幕像素画的，不随缩放变粗），
//    所以自动河走它就必须把世界单位换算成屏幕宽度 —— 见 `strokeRiverNetwork` 的 `widthPx`。
/** 自带河（FMG 导入）的描边色 —— 与 `ScenarioMap.drawRivers` 的 `#5d97bb` 同源。 */
export const BASEMAP_RIVER_COLOR = '#5d97bb';

/**
 * 🔴 **全图唯一的河色**（2026-10-17 第六修，用户第 N 次报色差）。
 *
 * 这条教训已经写过三遍，还是漏了**第四处**：
 *   · 2026-10-15：`drawRiverPaths` 写死 `#5d97bb` → 收口到 `RIVER_COLOR`；
 *   · 2026-10-16（第五修）：发现真正画出来的自带河是 `#5d97bb`，而 `RIVER_COLOR`
 *     **从来没被画出来过** → 自动河改对齐 `#5d97bb`；
 *   · 于是**手画河又变成唯一那个用 `#3B82F6` 的** → 用户 2026-10-17 截图：
 *     同一条河一半 `#5d97bb` 一半 `#3B82F6`（"色差依旧存在"）。
 *
 * 🔴 **可复用的判据（第四次强调）**：对齐观感要对齐**屏幕上实际画出来的那条线**。
 *    所以现在只有**一个**常量为真：`BASEMAP_RIVER_COLOR`（`#5d97bb`）。
 *    `RIVER_COLOR`（`#3B82F6`）**只作为数据里的默认值**存在 —— 它不再出现在任何描边路径上。
 *    凡是要画河的地方（自带河 / 自动河 / 手画河 / 预览 / 河流编辑器）都必须用本常量。
 *    `test_103` 有源码守卫：画布文件里不许再出现 `RIVER_COLOR` 作为 strokeStyle。
 */
export const RIVER_DRAW_COLOR = BASEMAP_RIVER_COLOR;

/**
 * 河的**岸线色**（比水面深一档）。
 *
 * 为什么需要：真实地图上的河不是一条蓝线贴在地上，而是"水 + 两岸"。
 * 只画水面时，河在暖色地形上会显得**发飘**（像荧光笔划的）。加一层深色岸线之后
 * 河就"嵌进地形"了 —— 这是用户给的那张参考图（真实世界地图）里最省事的一条差距。
 * ⚠️ 岸线色**不算第二种河色**：它是同一条河的暗部，不是另一条河的颜色。
 */
export const RIVER_BANK_COLOR = '#3f6478';

/** 选中轮廓离河岸的空隙（屏幕像素）—— 太小会贴着水色看不清，太大会显得"河变宽了" */
export const RIVER_SEL_GAP_PX = 3.5;

/** 选中轮廓的线宽（屏幕像素）—— 与 `RIVER_SEL_GAP_PX` 同族，都是**屏幕**口径 */
export const RIVER_SEL_WEIGHT_PX = 1.4;

/**
 * 选中轮廓的空隙 —— **按河的实际屏幕宽度收窄**。
 *
 * 🔴 为什么不能直接用 `RIVER_SEL_GAP_PX`（2026-10-18 第十六修补，被 `test_112` 的读数教回来）：
 *    那条河（`width=1`）在 1× 下只有 **3.6 屏幕像素**宽，而固定 3.5px 的空隙让两条轮廓线
 *    落在 ±5.3px 处 —— 配合各 1.4px 的线宽与稀疏采样，**水面保留率掉到 0.47~0.52**。
 *    "河越细、标记占的比例越大"是结构性事实，所以空隙必须跟着河宽收：
 *    细河给 ~1px（贴着河岸，仍然看得见），宽河才给满 3.5px。
 *
 * @param {number} baseScreenPx 河身屏幕宽度（像素）
 * @returns {number} 空隙（屏幕像素，1 ~ RIVER_SEL_GAP_PX）
 */
export function riverSelGapForWidth(baseScreenPx) {
  const w = Number.isFinite(baseScreenPx) && baseScreenPx > 0 ? baseScreenPx : 1;
  return Math.max(1, Math.min(RIVER_SEL_GAP_PX, w * 0.45));
}

/**
 * 折线的**平行偏移线**（纯几何）：每个点沿"相邻两段法线的平均方向"外移 `dist`。
 *
 * 🔴 为什么必须有它（2026-10-18 第十六修）：选中一条河时**不许把水面盖住**。
 *    暮雨原话：「那一条白色的显然就算选中河流的光晕，但是太诡异太离谱了，根本没办法正常绘图，
 *    把整条河都挡住。也许需要想想别的办法。只要用户能编辑河流就行了，而不是点下去没反馈。」
 *    旧实现（暖白光晕 + 亮芯，两遍加宽描边）与我的第一版修正（加宽的中心线虚线）**都会盖住水面**，
 *    因为它们的**中心就在河道中心线上** —— 「轮廓」不能靠"加粗的中心线"实现，必须真的算偏移几何。
 *    实测：加宽中心线版的水色保留率 **0.009**；改成两侧偏移后 **0.72~1.0**。
 *
 * ⚠️ 三个退化处理（都不许抛异常，画布抛异常会连坐整帧）：
 *   ① 空 / 单点 → 原样返回；② 相邻两点重合 → 用另一段的法线（避免 NaN）；
 *   ③ `dist` 为 0 → 原样拷贝。
 * ⚠️ 转角处两侧法线**取平均再归一化**：不归一化会在 90° 转角处把间距冲到 `2d√2 ≈ 2.83d`。
 *
 * @param {Array<{x:number,y:number}>} pts
 * @param {number} dist 正数 = 一侧、负数 = 另一侧（调用方给世界单位）
 * @returns {Array<{x:number,y:number}>} 新数组
 */
export function offsetPolyline(pts, dist) {
  const src = Array.isArray(pts) ? pts : [];
  if (src.length < 2 || !Number.isFinite(dist) || dist === 0) return src.map((p) => ({ x: p.x, y: p.y }));
  const segNormal = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return null;
    return { x: -dy / len, y: dx / len };
  };
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const prev = i > 0 ? segNormal(src[i - 1], src[i]) : null;
    const next = i + 1 < src.length ? segNormal(src[i], src[i + 1]) : null;
    let n = null;
    if (prev && next) {
      const mx = prev.x + next.x, my = prev.y + next.y;
      const mlen = Math.hypot(mx, my);
      n = mlen > 1e-9 ? { x: mx / mlen, y: my / mlen } : next;
    } else {
      n = next || prev;
    }
    if (!n) return src.map((p) => ({ x: p.x, y: p.y }));   // 全退化 → 原样
    out.push({ x: src[i].x + n.x * dist, y: src[i].y + n.y * dist });
  }
  return out;
}

/**
 * 折线的**逐点变距平行偏移**（纯几何；2026-10-26，逐点河宽配套）。
 *
 * 与 `offsetPolyline` 的差别只有一处：偏移量**逐点不同**。
 * 为什么必须有它：逐点变宽之后，选中轮廓若还用**常量**偏移，宽段的轮廓会压进水面
 * （水面保留率掉回第十六修之前的形态）、窄段又会飘出老远 —— 而 `test_112/119`
 * 量的正是"选中后水面还看得见多少"。
 *
 * ⚠️ 退化处理与 `offsetPolyline` 完全一致（单点 / 重合点 / 全零偏移都原样返回，不抛）。
 *
 * @param {Array<{x:number,y:number}>} pts
 * @param {number[]|number} dists 逐点偏移（世界单位，正负决定两侧）；长度不足时沿用最后一个
 * @returns {Array<{x:number,y:number}>} 新数组
 */
export function offsetPolylineVariable(pts, dists) {
  const src = Array.isArray(pts) ? pts : [];
  if (src.length < 2) return src.map((p) => ({ x: p.x, y: p.y }));
  const at = (i) => {
    if (Array.isArray(dists)) {
      const v = dists[Math.max(0, Math.min(dists.length - 1, i))];
      return Number.isFinite(v) ? v : 0;
    }
    return Number.isFinite(dists) ? dists : 0;
  };
  const segNormal = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return null;
    return { x: -dy / len, y: dx / len };
  };
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const prev = i > 0 ? segNormal(src[i - 1], src[i]) : null;
    const next = i + 1 < src.length ? segNormal(src[i], src[i + 1]) : null;
    let n = null;
    if (prev && next) {
      const mx = prev.x + next.x, my = prev.y + next.y;
      const mlen = Math.hypot(mx, my);
      n = mlen > 1e-9 ? { x: mx / mlen, y: my / mlen } : next;
    } else {
      n = next || prev;
    }
    if (!n) return src.map((p) => ({ x: p.x, y: p.y }));
    const d = at(i);
    out.push({ x: src[i].x + n.x * d, y: src[i].y + n.y * d });
  }
  return out;
}

/**
 * 河流的**逐点宽度因子**（纯函数；2026-10-26）。
 *
 * 目标形状：源头细 → 河口粗（参考图的河是"越往下游越宽"的）。这里只产出 **0.35~1 的因子**，
 * 绝对值仍由 `basemapRiverWidthPx`（按本图 width 分布归一化）决定 —— 两条口径分开，
 * 免得再出现"改这里、那里变了"。
 *
 * ⚠️ 方向由调用方给（`reversed`）：导入河是"去+原路回"折过的闭合路，哪端是河口必须由
 *    `pickRiverMouthEnd` 用**距海距离**判断 —— 用两端地形高度判断在这份数据上无效
 *    （实测 159 条河里 156 条两端落在同一格高度：97×45 的格距 18 单位，端点差不到一格）。
 *
 * @param {Array<{x:number,y:number}>} points 中心线（弧长参数化）
 * @param {{reversed?:boolean,min?:number,max?:number,gamma?:number}} [opts]
 * @returns {number[]} 与 points 等长
 */
export function riverWidthFactors(points, opts = {}) {
  const src = Array.isArray(points) ? points : [];
  const n = src.length;
  const out = new Array(n).fill(1);
  if (!n) return out;
  const min = Number.isFinite(opts.min) ? opts.min : 0.35;
  const max = Number.isFinite(opts.max) ? opts.max : 1;
  const gamma = Number.isFinite(opts.gamma) ? opts.gamma : 0.8;
  if (n === 1) { out[0] = max; return out; }
  let total = 0;
  const cum = new Array(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y);
    cum[i] = total;
  }
  // 全重合（长度 0）：没有"上下游"可言 → 均匀给满，绝不产出 NaN（NaN 线宽 = 整条不画）
  if (!(total > 1e-9)) { out.fill(max); return out; }
  const rev = !!opts.reversed;
  for (let i = 0; i < n; i++) {
    let t = cum[i] / total;
    if (rev) t = 1 - t;
    const tt = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = min + (max - min) * Math.pow(tt, gamma);
  }
  return out;
}

/**
 * 判断**哪一端是河口**（纯函数）：离海更近的那端。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {(x:number,y:number)=>number} distanceAt 该点"距海多远"（越小越靠海；无数据给 NaN）
 * @param {{fallback?:'first'|'last'}} [opts] 判不出来时用哪端（默认 last = 数据原本的方向）
 * @returns {'first'|'last'}
 */
export function pickRiverMouthEnd(points, distanceAt, opts = {}) {
  const src = Array.isArray(points) ? points : [];
  const fallback = opts.fallback === 'first' ? 'first' : 'last';
  if (src.length < 2 || typeof distanceAt !== 'function') return fallback;
  const d0 = distanceAt(src[0].x, src[0].y);
  const d1 = distanceAt(src[src.length - 1].x, src[src.length - 1].y);
  const f0 = Number.isFinite(d0);
  const f1 = Number.isFinite(d1);
  if (!f0 && !f1) return fallback;
  if (!f0) return 'last';
  if (!f1) return 'first';
  if (Math.abs(d0 - d1) < 1e-6) return fallback;
  return d0 < d1 ? 'first' : 'last';
}

/**
 * **变宽中心线**（分块描边）—— 河流唯一的画法（2026-10-20 第十九修）。 *
 * 为什么不是"左岸+右岸合成一个多边形再 fill"（十八修的做法，已废弃）：
 *   实测真实项目 30 条河 × 3 档宽度 = **90/90 都自交**（弯急处左右偏移互相穿过）。
 *   自交多边形用 nonzero 填充会在交叠处**抵消成洞** —— 屏幕上就是"两条边夹一条缝"，
 *   而且放大后更明显（用户截图正是如此）。这不是调参能修的，是几何结构问题。
 *
 * 现在：把中心线按**弧长分块**（默认 16 块），每块用该块中点的宽度描一次
 * （`lineCap:'round'` + `lineJoin:'round'`）。块与块共享端点 ⇒ 接缝被圆帽盖住；
 * 块内宽度恒定、块间宽度差只有 ~0.2px ⇒ 看不出跳变。**结构上不可能出现洞**。
 * 调用次数 = 每河 16 次（160 条河 ≈ 2.5k/帧），比逐段描边少一个数量级。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} pts 世界坐标中心线（已圆角/加密）
 * @param {number[]|number} widths 逐点宽度（世界单位，= 全宽）
 * @param {{color?:string, alpha?:number, chunks?:number, bankColor?:string, bankWidth?:number}} opts
 * @returns {number} 画出的块数
 */
export function strokeTaperedLine(ctx, pts, widths, opts = {}) {
  const src = Array.isArray(pts) ? pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  if (!ctx || src.length < 2) return 0;
  const chunks = Math.max(1, Math.min(
    Number.isFinite(opts.chunks) ? Math.floor(opts.chunks) : 16,
    src.length - 1,
  ));
  const wAt = (i) => {
    const v = Array.isArray(widths) ? widths[Math.max(0, Math.min(widths.length - 1, i))] : widths;
    return Number.isFinite(v) && v > 0 ? v : 0.35;
  };
  // 🔴 2026-10-21 第二十修：默认**不透明**（原 0.95）。
  //    分块描边在块与块的圆帽接缝处会**自己叠自己**：α=0.95 叠一次 ≈ 0.9975，
  //    在两种蓝之间形成一条更深的细芯——放大后看起来就像"河里还有一条线"。
  //    河本来就该是不透明的：不透明之后，接缝重叠在数学上不可能改变颜色
  //    （同样的颜色画两遍还是同一个颜色），这一类"双线"从结构上消失。
  //    ⚠️ 预览/草稿要半透明请显式传 `alpha`（如 0.85），不要改这里的默认值。
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 1;
  const bankWidth = Number.isFinite(opts.bankWidth) ? opts.bankWidth : 0;
  let drawn = 0;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let c = 0; c < chunks; c++) {
    const i0 = Math.floor((c * (src.length - 1)) / chunks);
    const i1 = Math.floor(((c + 1) * (src.length - 1)) / chunks);
    if (i1 <= i0) continue;
    const mid = Math.min(src.length - 1, Math.round((i0 + i1) / 2));
    const w = Math.max(0.35, wAt(mid));
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(src[i0].x, src[i0].y);
      for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(src[i].x, src[i].y);
      ctx.stroke();
    };
    if (bankWidth > 0) {
      // 岸线（默认关）：同一块先描深色、再描水色，水色盖住内侧
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = opts.bankColor || '#3f6478';
      ctx.lineWidth = w + Math.min(bankWidth, Math.max(0.35, w * 0.45));
      trace();
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = opts.color || RIVER_DRAW_COLOR;
    ctx.lineWidth = w;
    trace();
    drawn++;
  }
  ctx.restore();
  return drawn;
}

/**
 * **圆角折线**（中点二次曲线，开放折线）：把折线磨成真正的曲线。
 *
 * 为什么不是 Chaikin / 加 subdiv（2026-10-20 实测）：
 *   · Catmull-Rom 是**插值**曲线 —— 必须穿过每个控制点，直角原样保留；
 *   · Chaikin 只在切点处收角，段长差得大时收不动（实测 20 条真实河：
 *     平均转角 176° → 102°，最大仍 137°）；
 *   · 中点二次曲线（`tracePath` 同款）**不穿过**控制点，每个拐角都被抹成圆角，
 *     这正是"河"该有的形状。端点保留（源头/河口位置不动）。
 *
 * @param {Array<{x:number,y:number}>} pts
 * @param {number} [samples=4] 每个拐角的采样段数
 * @returns {Array<{x:number,y:number}>}
 */
export function smoothRiverLine(pts, samples = 4) {
  const src = Array.isArray(pts) ? pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  if (src.length < 3) return src.map((p) => ({ x: p.x, y: p.y }));
  const n = Math.max(2, Math.min(8, Math.floor(samples) || 4));
  const out = [{ x: src[0].x, y: src[0].y }];
  let cur = out[0];
  for (let i = 1; i < src.length - 1; i++) {
    const c = src[i];
    const b = { x: (src[i].x + src[i + 1].x) / 2, y: (src[i].y + src[i + 1].y) / 2 };
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const mt = 1 - t;
      out.push({
        x: mt * mt * cur.x + 2 * mt * t * c.x + t * t * b.x,
        y: mt * mt * cur.y + 2 * mt * t * c.y + t * t * b.y,
      });
    }
    cur = out[out.length - 1];
  }
  out.push({ x: src[src.length - 1].x, y: src[src.length - 1].y });
  return out;
}

/**
 * 把一条河画成**实心变宽线**（水面；可选一圈岸线）。
 *
 * ⚠️ 2026-10-20 第十九修：**不再走"多边形 fill"**（上一版的实现会自交 → 中间出洞）。
 * 现在直接调 `strokeTaperedLine`（分块描边，结构上不可能有洞）。
 * 岸线默认关（用户反复报的"两条边夹一条缝"里，深色岸线是那一半原因）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} pts 中心线（世界坐标；调用方负责先过曲线加密）
 * @param {number[]|number} widths 逐点宽度（世界单位）
 * @param {{color?:string, bankColor?:string, bankWidth?:number, alpha?:number, chunks?:number}} opts
 * @returns {number} 画出的块数（0 = 没画）
 */
export function fillRiverRibbon(ctx, pts, widths, opts = {}) {
  // 名字保留（调用点与用例都按它找），实现已换成"描边"：
  return strokeTaperedLine(ctx, pts, widths, {
    color: opts.color,
    alpha: opts.alpha,
    bankColor: opts.bankColor,
    bankWidth: opts.bankWidth,
    chunks: opts.chunks,
  });
}

/**
 * **按流量剪枝**：只留真正的河道，把"每格一根小棍"的密网格去掉。
 *
 * 🔴 为什么必须有（2026-10-17 第六修，用户：「自动河流依旧恐怖谷，我都懒得说了」）：
 *    河网段是**流向场本身** —— 每个能到海的陆地格一根小棍。实测（圆丘 + 121×121 网格）：
 *    **11225 段**，汇流量中位只有 **12**（p25=2、p90=45、max=136）。
 *    把一万多根等长小棍全画出来，屏幕上必然是一片**平行斜线网格** ——
 *    那不是"河"，那是噪声。真实地图只画河道（细支流根本不画）。
 *
 * 🔴 **闸门必须按分布取分位，不能按上界取比例**（2026-10-17 实测教训）：
 *    第一版写的是 `threshold = segMaxFlow × 0.25`。在圆丘数据上它工作得不错，
 *    但在**真实分布**上直接崩：那份数据段汇流 `p50 = 2`、`max = 1275`（极端长尾）——
 *    0.25×1275 = 319，于是 3750 段里只剩 **26 段**（0.7%），画布上几乎什么都没有。
 *    改成分位（默认留流量最高的 12%）之后，长尾数据也能留住**成百上千段主干**。
 *    ⚠️ 这与"按上界归一化"并不矛盾：**归一化的对象是分布，不是最大值**
 *      （第四修那条教训的完整版：绝对数字会失效，单一极值同样会失效）。
 *
 * 剪枝规则（**拓扑保留**，不是简单过滤）：
 *   ① 超过闸门的段 → 留下；
 *   ② 流量虽小、但它的**下游（receiver）被留下** → 也留下（否则干流会在半途断掉）；
 *   ③ 从低到高扫两遍（下游一般流量更大，两遍足够把整条链传下去）。
 * ⚠️ 不做"简单流量过滤"：那会把干流的细端也切掉，河网变成一堆互不相连的短刺。
 *
 * @param {Array<{x0:number,y0:number,x1:number,y1:number,flow:number}>} segments
 * @param {number} threshold 闸门（**绝对流量值**；调用方用 `riverFlowGate` 按分位算）
 * @param {{keys?:(seg:Object)=>string}} [opts] `keys` 返回"格"的唯一键（覆盖默认的量化键）
 * @returns {{kept:Array, dropped:number}}
 */
export function pruneRiverNetwork(segments, threshold, opts = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const out = { kept: [], dropped: 0 };
  if (!list.length) return out;
  const th = Number.isFinite(threshold) ? threshold : 0;
  if (!(th > 0)) { out.kept = list.slice(); return out; }
  const strong = (seg) => (Number.isFinite(seg && seg.flow) ? seg.flow : 1) >= th;

  // 🔴 格的**唯一键必须量化**（2026-10-17 第六修，我自己踩的 bug）：
  //    第一版直接拿 `${seg.x0},${seg.y0}` / `${seg.x1},${seg.y1}` 当键，而格心是**浮点坐标**
  //    （真实底图 spacing=14.4 → 0.1、14.5、28.9…）——上游段的 `x1,y1` 与下游段的 `x0,y0`
  //    数学上相同、**字符串未必逐字节相同** → 匹配失败 → 拓扑链断掉。
  //    实测后果：3750 段的河网只留下 **26 段**（0.7%），河网碎成一堆互不相连的短刺。
  //    更糟的是它**不报错**：画布上"有河但很稀"，看不出是剪枝剪坏了。
  //    量化到 0.01 世界单位：远小于任何格距，也远大于浮点噪声。
  const q = (v) => Math.round((Number.isFinite(v) ? v : 0) * 100);
  const cellKey = (x, y) => `${q(x)},${q(y)}`;
  const key = typeof opts.keys === 'function' ? opts.keys : (seg) => cellKey(seg.x0, seg.y0);

  // ① 先留强段 ② 再按"下游被留下"补两遍
  const keep = new Array(list.length).fill(false);
  const keptKey = new Set();
  for (let i = 0; i < list.length; i++) {
    if (strong(list[i])) { keep[i] = true; keptKey.add(key(list[i])); }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < list.length; i++) {
      if (keep[i]) continue;
      const seg = list[i];
      // 下游格 = 段的**终点**（段是"本格 → receiver"）：它被留下就把这一段也留下
      if (keptKey.has(cellKey(seg.x1, seg.y1))) { keep[i] = true; keptKey.add(key(seg)); }
    }
  }
  for (let i = 0; i < list.length; i++) if (keep[i]) out.kept.push(list[i]);
  out.dropped = list.length - out.kept.length;
  return out;
}

/**
 * 按**分位**求河网流量闸门（"留流量最高的百分之几"）。
 *
 * 为什么不是"上界的百分之几"：实测数据里段汇流是**极端长尾**
 * （`p50 = 2`、`max = 1275`）——按上界取比例会把闸门抬到 319，
 * 3750 段里只剩 26 段（画布上几乎空白）。按分位取就与分布形状无关。
 *
 * @param {Array<{flow:number}>} segments
 * @param {number} keepRatio 留多少比例（默认 0.12 = 最高的 12%）
 * @returns {number} 闸门（绝对流量值）；无数据时 0 = 不剪
 */
export function riverFlowGateByQuantile(segments, keepRatio = 0.12) {
  const flows = [];
  for (const s of (Array.isArray(segments) ? segments : [])) {
    const f = Number(s && s.flow);
    if (Number.isFinite(f)) flows.push(f);
  }
  if (!flows.length) return 0;
  flows.sort((a, b) => a - b);
  const r = Number.isFinite(keepRatio) ? Math.max(0.001, Math.min(1, keepRatio)) : 0.12;
  const idx = Math.floor(flows.length * (1 - r));
  const gate = flows[Math.max(0, Math.min(flows.length - 1, idx))];
  // 闸门至少 2：流量 1 的段是"每一格都有一根"的那种，永远不画
  return Math.max(2, gate);
}

/**
 * 把折线变成**平滑曲线**（Catmull-Rom 三点式，纯函数）。
 *
 * 为什么需要：追踪出来的点是**格心**，一格一跳 → 画出来是一串硬折角（"小棍拼的"）。
 * Chaikin（`polylineSmooth`）只**切角**、点密了仍然看得出折；Catmull-Rom 让曲线
 * 真正**穿过**控制点，于是稀疏的控制点也能画出连续的弯 —— 这才是"会弯"。
 *
 * 🔴 两个纪律：
 *   ① 端点**逐字保留**（源头 / 河口位置是用户看得见的读数）；
 *   ② 输出**每段固定 `subdiv` 个点**，所以点数 = (n-1)*subdiv + 1 —— 调用方要控成本
 *      就控 `subdiv`（画布上取 6~8，一个屏幕像素级的折角就看不见了）。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} [subdiv] 每段细分数（1 = 不加密）
 * @returns {Array<{x:number,y:number}>} 新数组
 */
export function catmullRomPoints(points, subdiv = 8) {
  const src = Array.isArray(points) ? points : [];
  if (src.length < 3) return src.map((p) => ({ x: p.x, y: p.y }));
  const n = Math.max(2, Math.min(32, Math.floor(subdiv) || 8));
  const at = (i) => src[Math.max(0, Math.min(src.length - 1, i))];
  const out = [{ x: src[0].x, y: src[0].y }];
  const c = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  for (let i = 0; i + 1 < src.length; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: c(p0.x, p1.x, p2.x, p3.x, t), y: c(p0.y, p1.y, p2.y, p3.y, t) });
    }
  }
  // 末点逐字归位（浮点累加不能动用户看见的河口坐标）
  out[out.length - 1] = { x: src[src.length - 1].x, y: src[src.length - 1].y };
  return out;
}

/**
 * 沿一条河**按比例造宽度序列**（源头细 → 河口粗）。
 *
 * 🔴 用户原话：「不会有粗细变化吗？你没看过真实的地图吗？」
 *    真实地图上每条河都**从源头到河口变粗**，而且这条变化是**人眼第一眼看的特征**。
 *    手画河此前是**一个线宽画到底**（`ScenarioMap.drawRiverPaths` 用 `r.width` 单值），
 *    所以哪怕形状对，看上去还是"一根管子"。自动河虽然逐点算宽度，但段太短、取值范围
 *    被 min/max 夹住 → 实测只有 1.4 倍，肉眼就是一样粗。
 *
 * 口径：`t` 从 0（源头）到 1（河口），宽度按 **1/3 次方**过渡 ——
 * 三次方根让细支流占更长的一段（真实河网里"细"的部分本来就长），
 * 而不是像线性那样一开始就猛涨。
 *
 * @param {number} count 需要的宽度个数（= 点数）
 * @param {number} w0 源头宽度（世界单位）
 * @param {number} w1 河口宽度（世界单位）
 */
export function taperWidths(count, w0, w1) {
  const n = Math.max(0, Math.floor(count) || 0);
  const out = new Array(n);
  if (n === 0) return out;
  if (n === 1) { out[0] = w1; return out; }
  const a = Number.isFinite(w0) && w0 > 0 ? w0 : 0.2;
  const b = Number.isFinite(w1) && w1 > 0 ? w1 : a;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // 🔴 指数取 **1.6（> 1）**：`t^1.6` 在 t 小时**远小于** t → 上游长时间保持很细，
    //    汇流累积到后半段才迅速变宽。真实河流就是这个形状（源头细长、近海口才变粗）。
    //    ⚠️ 我第一版写的是 `Math.pow(t, 0.35)`（< 1）—— 那个方向**正好相反**
    //       （t=0.1 时就是 0.45，起步就冲到一半宽，然后几乎不再变粗，看上去仍像等宽管子）。
    //       单测里"中点必须比线性细"这条把它当场抓住了。
    out[i] = a + (b - a) * Math.pow(t, 1.6);
  }
  return out;
}

/**
 * **变宽**描边（一条河一个不透明度、逐段不同宽度）—— "真实河流"的观感就靠它。
 *
 * 🔴 为什么不能用 Canvas 的单条路径：`lineWidth` 是**整条路径一个值**，
 *    要变宽只能逐段 `stroke()`。所以这里是 N 次 `beginPath/moveTo/lineTo/stroke`。
 *    N 由 `subdiv` 决定（每段 6~8 个子段），一条 40 点的河 ≈ 280 次调用 —— 亚毫秒级，
 *    比"每帧重画几百个节点圆"便宜得多。
 *
 * ⚠️ 逐段描边**必须在每段两端用同一宽度**（取相邻两点均值），否则会看到"竹节"。
 *    `lineCap='round'` + 共享端点 ⇒ 圆头拼接处无缝。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} pts 已经是**曲线**上的点（调用方先过 `catmullRomPoints`）
 * @param {number[]} widths 世界单位宽度，与 pts 等长
 * @param {{toPx:(w:number)=>number, color?:string, alpha?:number, minPx?:number,
 *          from?:number, to?:number}} opts `from`/`to` 只画一部分（源头淡出等）
 * @returns {number} 实际描出的段数
 */
export function strokeVariableWidth(ctx, pts, widths, opts = {}) {
  if (!ctx || !Array.isArray(pts) || pts.length < 2) return 0;
  const toPx = typeof opts.toPx === 'function' ? opts.toPx : null;
  if (!toPx) return 0;
  const minPx = Number.isFinite(opts.minPx) ? opts.minPx : 0.5;
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 0.92;
  const from = Math.max(0, Math.floor(Number.isFinite(opts.from) ? opts.from : 0));
  const to = Math.min(pts.length - 1, Number.isFinite(opts.to) ? Math.floor(opts.to) : pts.length - 1);
  const ws = Array.isArray(widths) ? widths : [];
  const wAt = (i) => {
    const v = ws[Math.max(0, Math.min(ws.length - 1, i))];
    return Number.isFinite(v) && v > 0 ? v : 0.2;
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = opts.color || RIVER_DRAW_COLOR;
  let drawn = 0;
  for (let i = from; i < to; i++) {
    const w = (wAt(i) + wAt(i + 1)) / 2;
    ctx.lineWidth = Math.max(minPx, toPx(w));
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
    ctx.stroke();
    drawn++;
  }
  ctx.restore();
  return drawn;
}

/**
 * 一次画完一条河：**曲线 + 变宽 + 河岸描边**（"看起来像真地图上的河"的最小配方）。
 *
 * 三层（与真实地图的观感对应）：
 *   ① 岸线：比水面深一档的细描边，宽度 = 水面 + 常量 → 让河有"堤岸"、不糊在地形里；
 *   ② 水面：主色（`RIVER_DRAW_COLOR`）；
 *   ③ 无亮芯、无光晕 —— 亮芯会让河"发光"（用户第五修就报过"发光的带子"）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} controlPts 控制点（稀疏；内部会加密成曲线）
 * @param {number} headWidth 源头宽度（世界单位）
 * @param {number} mouthWidth 河口宽度（世界单位）
 * @param {{toPx:(w:number)=>number, subdiv?:number, color?:string, bankColor?:string,
 *          bankPx?:number, alpha?:number}} opts
 * @returns {{drawn:number, curvePoints:number}}
 */
export function drawCurvedRiver(ctx, controlPts, headWidth, mouthWidth, opts = {}) {
  const ctrl = Array.isArray(controlPts) ? controlPts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  if (!ctx || ctrl.length < 2) return { drawn: 0, curvePoints: 0 };
  const subdiv = Number.isFinite(opts.subdiv) ? opts.subdiv : 7;
  // 只有 2 个控制点：曲线等于直线（Catmull-Rom 需要 3 点才弯），直接落回原折线
  const curve = (opts.curve === false || ctrl.length < 3)
    ? ctrl.map((p) => ({ x: p.x, y: p.y }))
    : catmullRomPoints(ctrl, subdiv);
  // 逐点宽度：调用方给了 `widths`（手画河的 widthFactors / 自带河按 discharge）就用它，
  // 否则按头→尾线性过渡（taperWidths）。
  let widths;
  if (Array.isArray(opts.widths) && opts.widths.length) {
    const src = opts.widths;
    widths = curve.map((_, i) => {
      const u = curve.length > 1 ? (i / (curve.length - 1)) * (src.length - 1) : 0;
      const i0 = Math.floor(u);
      const i1 = Math.min(src.length - 1, i0 + 1);
      const f = u - i0;
      const a = Number(src[i0]);
      const b = Number(src[i1]);
      const va = Number.isFinite(a) && a > 0 ? a : 0.2;
      const vb = Number.isFinite(b) && b > 0 ? b : 0.2;
      return va + (vb - va) * f;
    });
  } else {
    widths = taperWidths(curve.length, headWidth, mouthWidth);
  }
  const bankWidth = Number.isFinite(opts.bankPx) ? opts.bankPx : 0.9;
  // 不透明（同 `strokeTaperedLine`：分块接缝叠自己不能改颜色）——见那条注释
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 1;
  // 岸线宽：屏幕常量（调用方传的是 `px(1.1)` 世界值）与**水宽**取小 ——
  // 放大时水宽按世界单位涨，岸线若仍是常量就会变成粗边框（第十五修踩过的"铁轨"成因）。
  let maxW = 0;
  for (const w of widths) if (Number.isFinite(w) && w > maxW) maxW = w;
  const outline = bankWidth > 0 ? Math.min(bankWidth, Math.max(0.18, maxW * 0.35)) : 0;
  // 🔴 2026-10-20 第十七修：**一条实心丝带**取代"逐段描边 + 外扩岸线"。
  //    旧写法两遍逐段 stroke（岸线加宽、水面覆盖）在放大/缩小时都会露出
  //    "两条平行边 + 中间一条缝"的骨架 = 用户反复说的「铁轨」。
  //    现在一次闭合多边形：左岸正向 + 右岸反向 → 宽度连续、接头无缝；岸线是
  //    这同一个多边形的描边（0 宽 = 不描），所以**结构上不可能再出现两条轨道**。
  const drawn = fillRiverRibbon(ctx, curve, widths, {
    color: opts.color || RIVER_DRAW_COLOR,
    bankColor: opts.bankColor || '#3f6478',
    bankWidth: outline,
    alpha,
  });
  return { drawn, curvePoints: curve.length };
}

/** 自带河线宽的放缩（`ScenarioMap.drawRivers` 原式：`r.width * 6 * max(sqrt(discharge)/14, 0.6)`）。 */
export const BASEMAP_RIVER_WIDTH_SCALE = 6;

/**
 * **把「往返路径」折成一条中心线**（2026-10-21 第二十二修，真数据取证）。
 *
 * 🔴 真实项目 160 条导入河**全部**是闭合往返：`p[i] ≈ p[n-1-i]`（实测 160/160，
 *    首尾距离 0.4~1.4 世界单位）。也就是说 `.map` 里存的不是中心线，而是
 *    「去 + 原路回」—— 渲染出来必然是从折返点开始的两条平行线，中间夹着原河宽。
 *    这就是用户反复报的「从某个节点开始分支、变成双线」。
 *
 * 判据：后一半是前一半的**逆序重走**（80% 以上的对称点在 `tol` 内）。
 * 命中 → 只保留 `[0..floor(n/2)]`（含折返点）；否则原样返回（手画河/正常数据不受影响）。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {{tol?:number}} [opts]
 * @returns {Array<{x:number,y:number}>} 新数组
 */
export function collapseReversedRiverPoints(points, opts = {}) {
  const pts = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  const n = pts.length;
  const tol = Number.isFinite(opts.tol) && opts.tol > 0 ? opts.tol : 3.5;
  if (n < 6) return pts.map((p) => ({ x: p.x, y: p.y }));
  const half = Math.floor(n / 2);
  let same = 0;
  for (let i = 0; i < half; i++) {
    const a = pts[i], b = pts[n - 1 - i];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= tol) same++;
  }
  if (same < Math.ceil(half * 0.8)) return pts.map((p) => ({ x: p.x, y: p.y }));
  const keep = Math.min(n, Math.floor(n / 2) + 1);
  return pts.slice(0, keep).map((p) => ({ x: p.x, y: p.y }));
}

/**
 * 把 `[0, count)` 按「该点是否已被更宽的河覆盖」切成若干**连续 run**（闭开区间）。
 *
 * 用途（2026-10-21 第二十一修）：真实 FMG 数据里，支流的路径会**沿着干流的河身再走一遍**
 * （两条 `rivers[]` 共享同一段河道，只是控制点略有差异）。渲染时两条都画 → 屏幕上就是
 * 「一条粗河旁边贴着一条细线」，放大后从某个节点开始分叉成双线（用户给的两张截图）。
 * 这不是画法问题，是**同一段河道被画了两遍**。
 *
 * 口径：run 至少 2 个点（1 个点画不出线）；全被覆盖 → 空数组。
 *
 * @param {number} count
 * @param {(i:number)=>boolean} isCovered
 * @returns {Array<[number, number]>} `[start, end)` 列表
 */
export function uncoveredIndexRuns(count, isCovered) {
  const n = Math.max(0, Math.floor(count) || 0);
  const runs = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (isCovered(i)) {
      if (start >= 0 && i - start >= 2) runs.push([start, i]);
      start = -1;
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0 && n - start >= 2) runs.push([start, n]);
  return runs;
}

/** 点到线段的距离（`planRiverCoveredRuns` 内部用） */
function segPointDist(x, y, s) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / L2)) : 0;
  return Math.hypot(x - (s.x0 + dx * t), y - (s.y0 + dy * t));
}

/**
 * **绘制计划**：宽河先画；窄河只画「没有被更宽的河盖住」的连续段。
 *
 * 为什么不是改数据：同一段河道在数据里是两条独立 river（各有自己的源头与流量），
 * 删掉谁都会丢地名/分级；而屏幕上的重复是**绘制期的**问题，所以在绘制期去重。
 *
 * 判据（两个条件同时满足才算"盖住"）：
 *   ① 点到已画线段的距离 ≤ `dist`（世界单位，调用方按屏幕像素换算）；
 *   ② 局部方向与线段方向夹角 ≤ ~45°（`dirDot` 0.7）—— **横穿的支流不许被吃掉**。
 *
 * @param {Array<{points:Array<{x:number,y:number}>, widthPx:number}>} rivers
 * @param {{dist?:number, dirDot?:number}} [opts]
 * @returns {Array<Array<[number,number]>>} 与入参等长的 run 列表
 */
export function planRiverCoveredRuns(rivers, opts = {}) {
  const list = Array.isArray(rivers) ? rivers : [];
  const dist = Number.isFinite(opts.dist) && opts.dist > 0 ? opts.dist : 6;
  const minDot = Number.isFinite(opts.dirDot) ? opts.dirDot : 0.7;
  const out = new Array(list.length);
  const order = list.map((_, i) => i).sort((a, b) =>
    (Number(list[b].widthPx) || 0) - (Number(list[a].widthPx) || 0) || a - b);
  const cell = dist;
  const buckets = new Map();
  const addSeg = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (!(L > 1e-9)) return;
    const seg = { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dx: dx / L, dy: dy / L };
    const i0 = Math.floor(Math.min(a.x, b.x) / cell), i1 = Math.floor(Math.max(a.x, b.x) / cell);
    const j0 = Math.floor(Math.min(a.y, b.y) / cell), j1 = Math.floor(Math.max(a.y, b.y) / cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i},${j}`;
        let arr = buckets.get(k);
        if (!arr) { arr = []; buckets.set(k, arr); }
        arr.push(seg);
      }
    }
  };
  const coveredAt = (x, y, dx, dy) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const arr = buckets.get(`${cx + i},${cy + j}`);
        if (!arr) continue;
        for (const s of arr) {
          if (Math.abs(s.dx * dx + s.dy * dy) < minDot) continue;
          if (segPointDist(x, y, s) <= dist) return true;
        }
      }
    }
    return false;
  };
  for (const idx of order) {
    const pts = (list[idx] && list[idx].points) || [];
    const n = pts.length;
    if (n < 2) { out[idx] = []; continue; }
    const dirAt = (i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      return L > 1e-9 ? { x: dx / L, y: dy / L } : { x: 1, y: 0 };
    };
    const flags = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = dirAt(i);
      flags[i] = coveredAt(pts[i].x, pts[i].y, d.x, d.y);
    }
    const runs = uncoveredIndexRuns(n, (i) => flags[i]);
    out[idx] = runs;
    for (const [s, e] of runs) {
      for (let i = s; i + 1 < e; i++) addSeg(pts[i], pts[i + 1]);
    }
  }
  return out;
}

/** 实测的 discharge 区间（desite 底图 160 条河：min 36 / p50 96 / max 613）。 */
export const BASEMAP_RIVER_DISCHARGE_RANGE = [36, 613];

/**
 * 汇流量 → 「自带河口径」的 discharge 当量（供 `basemapRiverWidthPx` 用）。
 *
 * 为什么要有这一步：自带河的线宽吃 `discharge`，自动河的段只有 `flow`（汇流格数）。
 * 两者量纲不同，直接把 flow 当 discharge 会得到 `max(0.7, 0.03*6*0.6) = 0.7px` ——
 * 全网一律最细。这里把 flow 按**本幅图的段流量范围**归一化后再映射到实测的 discharge
 * 区间，于是自动河的粗细分布落在自有河同一量程里。
 *
 * ⚠️ 与 `flowWidthScale` 同一个道理（第四修教训一）：**按本数据的范围归一化**，
 *    绝对公式换个地形就失效，而失效表现是"看起来没生效"。
 */
export function flowToDischargeEquivalent(flow, maxFlow, range = BASEMAP_RIVER_DISCHARGE_RANGE) {
  const lo = range[0], hi = range[1];
  const f = Number.isFinite(flow) && flow > 0 ? flow : 1;
  const m = Number.isFinite(maxFlow) && maxFlow > 1 ? maxFlow : Math.max(2, f);
  const t = Math.max(0, Math.min(1, (f - 1) / (m - 1)));
  return lo + (hi - lo) * Math.sqrt(t);
}

/**
 * 线宽（**屏幕像素**）—— 与 `ScenarioMap.drawRivers` **同一条公式**。
 *
 * ⚠️ 两处必须共用：各写一份就会出现"自带河 1px、自动河 3px"这种一眼可见但不报错的不一致
 *    （这正是用户报的观感问题的成因）。`test_river_coastline.js` 有守卫钉住两侧同式。
 */
export function basemapRiverWidthPx(river, maxWidth) {
  // 🔴 2026-10-20 第十八修（用户：「河流依旧是两条边夹一条缝」）：
  //    旧式 `width * 6 * max(sqrt(discharge)/14, 0.6)` 在这份真实数据上**根本没生效** ——
  //    415 省底图的 160 条河 `width` 只有 0.03~0.26（p50 0.07），算出来 0.29px，
  //    全被 0.7 的地板夹住 → **每条河都是 0.7px 的发丝**。发丝上再压一圈深色岸线，
  //    就只剩"两条边夹一条缝"。
  //    现在按**本幅图自己的 width 分布**归一化（与 flowWidthScale 同一条纪律：
  //    归一化的对象是分布，不是某个绝对公式），最细 1.2px、主干 4.6px。
  const r = river || {};
  const w = Number(r.width);
  const width = Number.isFinite(w) && w > 0 ? w : 0;   // 缺数据 = 最细
  const ref = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0.26;  // 实测 p100
  const t = Math.max(0, Math.min(1, width / ref));
  // 🔴 2026-10-26（用户原话「河流太粗太丑，像虫子在爬」+ 意大利地形图对照）：
  //    我一度把区间压到 [1.2, 2.6]，结果 **test_112/119 的"选中后水面保留率"从 0.83 掉到 0.42**
  //    （< 0.6 的判据）—— 细河撑不住那圈选中高亮，整条会被描边吃掉。
  //    所以**区间维持 1.2~4.6 不动**（导入河也吃这条公式，改它会动用户已有底图）；
  //    "支流也和干流一样粗"的真正来源在数据侧：生成器给每条河的 width 都挤在 0.1~0.26，
  //    归一化后几乎每条都顶到 4.6px → 改 `landmass.js` 的流量→宽度曲线（指数 ^1.6）。
  //    取到 0.01px：浮点尾差（1.2+3.4=4.6000000000000005）会让用例的 `=== 4.6` 假红。
  const v = Math.max(1.2, Math.min(4.6, 1.2 + 3.4 * Math.pow(t, 0.55)));
  return Math.round(v * 100) / 100;
}

/** 自带河线宽（世界单位）—— 给 `strokeRiverNetwork` 的 `widthPx` 用（它按世界单位收宽度）。 */
export function basemapRiverWidthWorld(river, pxPerWorld, maxWidth) {
  const pxw = basemapRiverWidthPx(river, maxWidth);
  const k = Number.isFinite(pxPerWorld) && pxPerWorld > 0 ? pxPerWorld : 0;
  return k > 0 ? pxw / k : pxw;
}

/** 线宽（世界单位）的下限与上限。
 *  🔴 这两个数字必须**配得上地形的真实汇流量量程**（2026-10-14 第四修）：
 *  旧值 0.7~5.0 是按"汇流量能到上千"想的，而这份地形实测 `segMaxFlow = 20`、
 *  中位 5 —— 立方根下整条河只从 1.49 涨到 2.11（**1.4 倍**），肉眼根本看不出渐变
 *  （用户实测截图：「河流并没有越往下游越宽」）。
 *  现在的口径见 `flowWidthScale`：**按本幅图的流量范围归一化**，最细到最粗拉开 4 倍以上。 */
export const RIVER_W_MIN_WORLD = 0.8;
export const RIVER_W_MAX_WORLD = 5.0;

/**
 * 线宽口径（**唯一实现**，两处渲染共用）：汇流量 → 世界单位宽度。
 *
 * 🔴 为什么不能再用 `0.55 + cbrt(flow) * 0.75`（2026-10-14 第四修，用户实测）：
 *    那是个**绝对**口径 —— 它假设 flow 能到几百上千。这份地形实测 flow ∈ [1, 20]，
 *    于是"源头 1.49 → 河口 2.11"，**1.4 倍**，画出来就是一样粗（截图证实）。
 *    正确做法是**相对**口径：要知道本幅图的流量范围（`maxFlow`），把它归一化到 0..1，
 *    再映射到宽度区间。这样"最粗的干流"永远是最粗的，与地形量程无关。
 *
 * 形状取 `sqrt`（而不是立方根）：归一化之后 0..1 的区间上，sqrt 给低流量更多区分度
 * （0.05 → 0.22），cbrt 会把细支流全压到 0.37 以上、反而看不出细。
 *
 * @param {number} flow 该点的汇流量
 * @param {number} maxFlow 本幅图**段**汇流量的上界（`traceRivers().segMaxFlow`）
 * @param {{min?:number,max?:number}} [opts]
 */
export function flowWidthScale(flow, maxFlow, opts = {}) {
  const min = Number.isFinite(opts.min) ? opts.min : RIVER_W_MIN_WORLD;
  const max = Number.isFinite(opts.max) ? opts.max : RIVER_W_MAX_WORLD;
  const f = Number.isFinite(flow) && flow > 0 ? flow : 1;
  // ⚠️ `maxFlow` 无效时退回"局部口径"（1 段也要能画出来），绝不返回 NaN
  const m = Number.isFinite(maxFlow) && maxFlow > 1 ? maxFlow : Math.max(2, f);
  const t = Math.max(0, Math.min(1, (f - 1) / (m - 1)));   // f=1 → 0，f=maxFlow → 1
  const w = min + (max - min) * Math.sqrt(t);
  return Math.max(min, Math.min(max, w));
}

/**
 * 汇流量 → 线宽（**世界单位**，调用方自己 `px()` 换成屏幕像素）。
 *
 * ⚠️ **这是"旧绝对口径"，新代码请用 `flowWidthScale(flow, maxFlow)`。**
 *    它假设 flow 能到几百上千（1 → 1.2、8 → 2.1、64 → 3.4、512 → 4.9），
 *    而这份地形 flow 只有 1~20 → 整条河 1.49→2.11（1.4 倍），肉眼是一样粗。
 *    保留它是为了让"没有 maxFlow 信息"的调用方（手画河 / 旧数据）仍有一个可用口径，
 *    而不是到处散落 `0.55 + cbrt(f)*0.75` 这个魔数。
 *
 * @param {number} flow 该点的汇流量（≥1）
 * @param {{min?:number,max?:number}} [opts]
 */
export function riverWidthAt(flow, opts = {}) {
  const f = Number.isFinite(flow) && flow > 0 ? flow : 1;
  const min = Number.isFinite(opts.min) ? opts.min : RIVER_W_MIN_WORLD;
  const max = Number.isFinite(opts.max) ? opts.max : RIVER_W_MAX_WORLD;
  const w = 0.55 + Math.cbrt(f) * 0.75;
  return Math.max(min, Math.min(max, w));
}

/**
 * 把一条河变成**绘图指令**：点 + 逐点宽度（世界单位）+ 逐段采样的流量。
 *
 * `stride` 的含义：追踪出来的点是**格心**，相邻两点就是"一格"，而画布上那一格可能只有
 * 3~4 个屏幕像素 —— 逐点描会得到一串宽度跳变的小段（观感是"一节一节的"）。
 * 所以按 `step`（默认 1/3 格）采样后再逐段描：段更短 → 宽度过渡更连续。
 *
 * ⚠️ 采样**只做沿线插值**，不引入新几何（点都落在原折线上）；`flows` 缺失时按常数宽度画
 * （`flows` 是可选的：手画河 / 旧数据没有这个字段）。
 *
 * @param {{points?:Array, flows?:ArrayLike<number>, flow?:number, width?:number}} river
 * @param {{spacing?:number, step?:number, widthMin?:number, widthMax?:number,
 *          maxSamplesPerCell?:number}} [opts]
 * @returns {{pts:Array<{x:number,y:number}>, widths:number[], worldLen:number}|null}
 *   折线点数 < 2 时返回 null（调用方跳过）
 */
export function buildRiverPolyline(river, opts = {}) {
  const raw = river && (Array.isArray(river) ? river : river.points);
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const spacing = Number.isFinite(opts.spacing) && opts.spacing > 0 ? opts.spacing : 14.4;
  // 每格最多拆几段：逐段描边是**每段两次 stroke 调用**，这个数字直接决定每帧的调用次数。
  // 实测（真实底图 82 条河 / 每条约 5 格）每格 2 段时每帧约 2.6k 次调用，亚毫秒级；
  // 真正会炸的是"给每条河几千个点"的病态数据，所以上限留着 —— 但它**只约束默认步长**，
  // 调用方显式给了 `step` 就按它来（显式意图优先，测试与调参都靠它）。
  const maxPerCell = Number.isFinite(opts.maxSamplesPerCell) && opts.maxSamplesPerCell > 0
    ? Math.min(8, opts.maxSamplesPerCell) : 2;
  const step = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : spacing / maxPerCell;
  const flows = (river && river.flows) || null;
  const constWidth = Number.isFinite(river && river.width) ? river.width : null;
  const fallbackFlow = Number.isFinite(river && river.flow) ? river.flow : 1;

  // 逐点宽度：没有 flows → 常数（手画河 / 旧数据）
  //
  // 🔴 2026-10-14 第四修：有 `opts.maxFlow`（本幅图**段**汇流量上界）时走**归一化**口径
  //    （`flowWidthScale`）—— 绝对口径在这份地形上只给出 1.4 倍的粗细变化，看不出渐变。
  const maxFlow = Number.isFinite(opts.maxFlow) ? opts.maxFlow : null;
  const ptWidth = (i) => {
    if (constWidth != null) return constWidth;
    if (!flows || !flows.length) return riverWidthAt(fallbackFlow, opts);
    const k = Math.min(flows.length - 1, Math.max(0, i));
    if (maxFlow != null) return flowWidthScale(flows[k], maxFlow, opts);
    return riverWidthAt(flows[k], opts);
  };

  const pts = [];
  const widths = [];
  let worldLen = 0;
  for (let i = 0; i + 1 < raw.length; i++) {
    const a = raw[i], b = raw[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(segLen / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      // 段内的宽度按两端线性过渡（汇流量在相邻两格之间是渐变，不是台阶）
      widths.push(ptWidth(i) + (ptWidth(i + 1) - ptWidth(i)) * t);
    }
    worldLen += segLen;
  }
  pts.push({ x: raw[raw.length - 1].x, y: raw[raw.length - 1].y });
  widths.push(ptWidth(raw.length - 1));
  return { pts, widths, worldLen };
}

/**
 * 把一条河画到 canvas 上（**逐段**描边，因为 Canvas 2D 的单条路径不能变宽）。
 *
 * 两遍描边：
 *   · 外层：`strokeStyle`（默认 `RIVER_STROKE`），宽度 × 2.4，alpha 0.35 → 让河从地形里"浮"出来；
 *   · 内层：`coreColor`（默认 `RIVER_CORE`），宽度 × 1.0 → 亮芯。
 * 两遍都用 `lineCap='round'`；逐段之间**共享端点**（相邻段端点坐标逐位相同），
 * 所以圆头拼接处不会出现缝隙。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{pts:Array,widths:number[]}} poly `buildRiverPolyline` 的产物
 * @param {{toPx:(w:number)=>number, strokeStyle?:string, coreColor?:string,
 *          scale?:number, washScale?:number, washAlpha?:number,
 *          minPx?:number}} opts `toPx` = 世界单位 → 屏幕像素（必填）
 * @returns {number} 实际描出的段数（0 = 什么都没画，调用方可以据此回报）
 */
export function strokeRiver(ctx, poly, opts = {}) {
  if (!ctx || !poly || !poly.pts || poly.pts.length < 2) return 0;
  const toPx = typeof opts.toPx === 'function' ? opts.toPx : null;
  if (!toPx) return 0;
  const minPx = Number.isFinite(opts.minPx) ? opts.minPx : 0.6;
  const washScale = Number.isFinite(opts.washScale) ? opts.washScale : 2.4;
  const washAlpha = Number.isFinite(opts.washAlpha) ? opts.washAlpha : 0.35;
  const stroke = opts.strokeStyle || RIVER_STROKE;
  const core = opts.coreColor || RIVER_CORE;
  const pts = poly.pts, ws = poly.widths;

  let drawn = 0;
  // ── 外层（浅色描边）──────────────────────────────────────────────────────
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.globalAlpha = washAlpha;
  for (let i = 0; i + 1 < pts.length; i++) {
    const w = ((ws[i] + ws[i + 1]) / 2) * washScale;
    const lw = Math.max(minPx, toPx(w));
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
    ctx.stroke();
    drawn++;
  }
  // ── 内层（亮芯）──────────────────────────────────────────────────────────
  ctx.globalAlpha = 1;
  ctx.strokeStyle = core;
  for (let i = 0; i + 1 < pts.length; i++) {
    const w = (ws[i] + ws[i + 1]) / 2;
    ctx.lineWidth = Math.max(minPx, toPx(w));
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
    ctx.stroke();
  }
  ctx.restore();
  return drawn;
}

/**
 * 把**河网段**画到 canvas 上 —— 树枝状汇聚的观感就是从这里来的。
 *
 * 🔴 为什么必须有这一条（2026-10-14 第四修，用户实测截图原话：
 *    「根本画不出复杂的河流汇聚（树枝状的河流，如多条河流汇总到一条大河最终入海）。
 *      地图自带河流做的比自动河流好」）：
 *    `rivers[]` 是"每个源头一条**代表路径**"—— 一条折线从头走到海，**不含**沿途汇进来的支流。
 *    实测 desite 底图：源头高度 60 → 3 条河、**12 个点**；降到 40 → 67 条 / 270 个点；
 *    而陆地有 **2506 格**。所以画面上只能是"几根孤立的线"，**结构上画不出树枝状汇聚**。
 *    段（`traceRivers().segments`）是**流向场本身**（1717 段），支流一格一格汇进干流 ——
 *    这才是河网的几何本体。
 *
 * 两遍描边与 `strokeRiver` 同一套口径（外层浅色 ×2.4/alpha .35 + 内层亮芯），
 * 但**逐段单独描**：段与段共享端点（receiver 的格心逐位相同），圆头拼接天然无缝。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x0:number,y0:number,x1:number,y1:number,flow:number,endInSea?:boolean}>} segments
 * @param {{toPx:(w:number)=>number, maxFlow?:number, strokeStyle?:string, coreColor?:string,
 *          washScale?:number, washAlpha?:number, minPx?:number,
 *          widthPx?:(seg:Object)=>number, singlePass?:boolean, solid?:boolean,
 *          curve?:(seg:Object)=>{x:number,y:number}|null,
 *          clip?:(x0:number,y0:number,x1:number,y1:number)=>boolean}} opts
 *   `widthPx` = **屏幕像素**线宽的直接来源（给了它就完全绕开世界单位口径）。
 *     用于「与地图自带河流逐字对齐」：自带河就是按屏幕像素画、不随缩放变粗的，
 *     自动河要看起来是同一条网络就必须同量纲（2026-10-16 第五修，用户实测色差/粗细不一致）。
 *   `singlePass` = 只画一遍描边（不自带河的画法里没有光晕）。默认 false（保留两遍观感）。
 *   🔴 `curve` = **让段变成弯的**（2026-10-17 第六修）：返回一个"离段有偏移"的中间控制点，
 *     本函数就用它把 `(x0,y0)→控制点→(x1,y1)` 描成一条小弧。
 *     为什么必须有：段是"格→格"的直线，几百根直线拼在一起就是用户说的
 *     「不会弯吗？」—— 而**真实河流从来没有直段**。弧的幅度由调用方给（见
 *     `ScenarioMap` 里的 `riverMeanderAmount`：按段长比例 + 固定世界单位上限）。
 *     返回 null / 不给 ⇒ 保持直线（零行为变更，老调用方与老用例不受影响）。
 *   `clip` = 可选**逐段可见性/裁剪**回调：返回 false 就跳过这一段（调用方用它把
 *   "钻进海里"的段挡掉 —— 那正是用户报的「依然过度延伸到海洋部分」）。
 * @returns {{drawn:number, skipped:number}}
 */
export function strokeRiverNetwork(ctx, segments, opts = {}) {
  const out = { drawn: 0, skipped: 0 };
  if (!ctx || !Array.isArray(segments) || !segments.length) return out;
  const toPx = typeof opts.toPx === 'function' ? opts.toPx : null;
  const widthPx = typeof opts.widthPx === 'function' ? opts.widthPx : null;
  if (!toPx && !widthPx) return out;
  const minPx = Number.isFinite(opts.minPx) ? opts.minPx : 0.55;
  const washScale = Number.isFinite(opts.washScale) ? opts.washScale : 2.4;
  const washAlpha = Number.isFinite(opts.washAlpha) ? opts.washAlpha : 0.35;
  const stroke = opts.strokeStyle || RIVER_STROKE;
  const core = opts.coreColor || RIVER_CORE;
  const maxFlow = Number.isFinite(opts.maxFlow) ? opts.maxFlow : 0;
  const clip = typeof opts.clip === 'function' ? opts.clip : null;
  const singlePass = opts.singlePass === true;
  const solid = opts.solid === true;
  const curve = typeof opts.curve === 'function' ? opts.curve : null;

  // 先把要画的段挑出来（避免两遍里各判一次 clip，也避免 save/restore 里做分支）
  const list = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg) continue;
    if (clip && !clip(seg.x0, seg.y0, seg.x1, seg.y1)) { out.skipped++; continue; }
    // 宽度：`widthPx`（屏幕像素）优先 —— 与自带河同量纲；否则退回世界单位口径
    const w = widthPx ? 0 : flowWidthScale(seg.flow, maxFlow, opts);
    // 曲线：给了 `curve` 且它返回了控制点才走弧线（否则保持老直线，逐字不变）
    let mid = null;
    if (curve) {
      const c = curve(seg);
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) mid = c;
    }
    list.push({ seg, w, px: widthPx ? widthPx(seg) : 0, mid });
  }
  if (!list.length) return out;

  const pxOf = (item) => {
    if (widthPx) {
      const v = Number.isFinite(item.px) ? item.px : minPx;
      return Math.max(minPx, v);
    }
    return Math.max(minPx, toPx(item.w));
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!singlePass && !solid) {
    // 外层光晕（自带河**没有**这道；只有走旧两遍口径时才画）
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = washAlpha;
    for (const item of list) {
      ctx.lineWidth = pxOf(item) * washScale;
      ctx.beginPath();
      ctx.moveTo(item.seg.x0, item.seg.y0);
      if (item.mid) ctx.quadraticCurveTo(item.mid.x, item.mid.y, item.seg.x1, item.seg.y1);
      else ctx.lineTo(item.seg.x1, item.seg.y1);
      ctx.stroke();
    }
  }
  // 主描边（自带河口径下这就是**唯一**一遍）
  ctx.globalAlpha = 1;
  ctx.strokeStyle = solid || singlePass ? stroke : core;
  for (const item of list) {
    ctx.lineWidth = pxOf(item);
    ctx.beginPath();
    ctx.moveTo(item.seg.x0, item.seg.y0);
    if (item.mid) ctx.quadraticCurveTo(item.mid.x, item.mid.y, item.seg.x1, item.seg.y1);
    else ctx.lineTo(item.seg.x1, item.seg.y1);
    ctx.stroke();
    out.drawn++;
  }
  ctx.restore();
  return out;
}
