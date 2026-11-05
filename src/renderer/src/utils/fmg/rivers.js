// utils/fmg/rivers.js —— **河流网络的唯一实现**（2026-11-04：按 FMG 真实源码重抄）
//
// 上一版（2026-11-03）是"看着像 FMG"的自创管线：flux 分位选源 → 逐格段 → 横向并流（lateral）
// → 后再把段拼成链。它有三处结构性毛病，实测都能量出来（`build/river-preview/*.png`
// + `node scripts/tests/tools/_preview_rivers.mjs`）：
//   ① **孤立短段**：被"并流"吃掉的格子不出发段，于是它上游那些段在它那里断头
//      （真实 415 省底图 11 条、合成环岛 43 条；每条都只有 2~4 个点）；
//   ② **没有河的身份**：只有格子，没有"这条河从哪起源、汇进谁、是什么支流"——
//      河名/分级/导航全都无处挂；
//   ③ **不弯**：Catmull-Rom 穿过格心，等于"把格点连成线"，FMG 那种手绘感来自
//      **meander（在每个格点之间插垂直偏移控制点）**，这一层此前完全没抄。
//
// 本版逐条对齐上游实现（Azgaar/Fantasy-Map-Generator，MIT）：
//   · `src/model/physical/river-generator.ts` —— drainWater / flowDown / defineRivers /
//     resolveDepressions / addMeandering / getOffset / getWidth / getSourceWidth
//   · `src/utils/path-utils.ts` —— meander / relaxAcuteAngles
//   · `src/renderers/draw-rivers.ts` —— 每条河一条**闭合多边形**（左岸 + 右岸），不是描折线
//
// 与上游**不同的地方**（都是本项目的现实约束，逐条写明，免得下一个人以为抄漏了）：
//   ① 上游在 _pack_ 的 Voronoi 格上做（~1 万点），我们在**方格栅格**上做（97×45 ~ 192×192）。
//      格距因此差 5 倍，meander 的"25/64"距离阈值与振幅都按 `spacing / 4` 缩放（见 MEANDER）。
//   ② 上游把湖当 `features`（面积/水位/outlet/inlets/flux/evaporation）；我们只有
//      `hm.lakes = [{level, cells}]`（渲染层水面标记）。所以湖只做**进水/出水**两件事：
//      河在湖岸断（`endInLake`）、湖出口另起一条河（`parent` 接到进水干流），
//      **不做蒸发/闭合湖判定** —— 那需要湖的汇水面积与气候数据，等湖升格成一等对象再说。
//   ③ 上游用 Uint8Array 存高度、Uint16Array 存 flux（会截断）；我们用浮点，不截断。
//   ④ 上游有 `downcutRivers`（按流量下切河床 = 侵蚀）；我们不动高度场（高度图是用户的资产）。
//
// 本模块仍是**纯函数**（零 DOM / 零 Vue），可直接在 Node 里跑（`test_fmg_rivers.js`）。

// 洼地填平（上游 `resolveDepressions` 的同一件事）：仓内唯一实现，别另写一份 priority-flood。
import { clipPolylinesToCoast, MOUTH_OVERSHOOT } from '../coastline.js';
import { fillDepressions } from '../terrainSynthesis.js';

/** 8 邻域（dx, dy, 距离权重） */
const NB = [  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** 上游同名常量：汇流量低于它就不成河（单位 = 降水当量，见 `prec` 口径） */
export const MIN_FLUX_TO_FORM_RIVER = 30;

/** 上游 `defineRivers`：少于 3 格的"河"直接丢掉（这是"没有短棍"的结构性保证） */
export const MIN_RIVER_CELLS = 3;

/** 河宽公式的常量（上游 `RiverModule` 的字段，逐字抄） */
const WIDTH = {
  FLUX_FACTOR: 500,
  MAX_FLUX_WIDTH: 1,
  LENGTH_FACTOR: 200,
  LENGTH_STEP_WIDTH: 1 / 200,
  LENGTH_PROGRESSION: [1, 1, 2, 3, 5, 8, 13, 21, 34].map((n) => n / 200),
};

/**
 * FMG 的 meander 参数（`path-utils.ts` 的常量 + 按格距缩放，见文件头 ①）。
 * 上游的阈值是"格距 ≈ 4 单位"下定的（`dist2 <= 25`、振幅 ≈ 0.5~1.5），
 * 我们的格距是 4~18 → 单位 = spacing / 4，振幅按同一比例放大，观感才一致。
 */
const MEANDER = {
  MEANDERING: 0.5,
  WATER_MEANDER_SCALE: 0.25,
  RELAX_ITERATIONS: 4,
  BASE_STEP: 10,
};

/**
 * 找每个格子的**最陡下坡邻居**（严格更低才收）。
 * 与 FMG 一样：先按高度降序处理，遇到平地/洼地就原地不流（由调用方先把洼地填平）。
 * @returns {Int32Array} 下标 → 下游下标（-1 = 无）
 */
export function downslope(h, cols, rows) {
  const n = cols * rows;
  const down = new Int32Array(n).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const hi = h[i];
      let best = -1, bestDrop = 0;
      for (const [dx, dy, dist] of NB) {
        const cc = c + dx, rr = r + dy;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const j = rr * cols + cc;
        const drop = (hi - h[j]) / dist;
        if (drop > bestDrop) { bestDrop = drop; best = j; }
      }
      down[i] = best;
    }
  }
  return down;
}

/** 汇流量（flux）：每个格子先算 1，再按高度**从高到低**把自身的量灌进下游（旧口径，保留给对照/用例） */
export function accumulateFlux(h, down, seaLevel) {
  const n = h.length;
  const flux = new Float64Array(n);
  const order = Array.from({ length: n }, (_, i) => i)
    .filter((i) => h[i] > seaLevel)
    .sort((a, b) => h[b] - h[a]);
  for (const i of order) flux[i] += 1;
  for (const i of order) {
    const d = down[i];
    if (d >= 0) flux[d] += flux[i];
  }
  return flux;
}

/**
 * 引擎河网 → **落盘形状**（`baseMaps[key].rivers`：`{id,name,points:[{x,y}],width,discharge}`）。
 * 2026-11-04：生成地形时用它把河一起写进同一条 undo（用户不必再点一次“自动河流”）。
 * 坐标量化到 0.01：与高度图/项目文件的精度一致，体积也能砍一半。
 */
export function toStoredRivers(network, opts = {}) {
  const round = Number.isFinite(opts.round) && opts.round >= 0 ? Math.min(3, Math.floor(opts.round)) : 2;
  const k = Math.pow(10, round);
  const q = (v) => Math.round(Number(v) * k) / k;
  let list = ((network && network.rivers) || []).map((r, i) => ({
    id: `river_gen_${r.id || i + 1}`,
    name: '',
    points: ((r.points) || []).map((p) => ({ x: q(p.x), y: q(p.y) })),
    // 焊接时要用它排序（先接受干流），以及判断谁是更大的一侧
    discharge: Number.isFinite(r.discharge) ? r.discharge : 0,
    width: r.width,
    flow: Number.isFinite(r.flow) ? r.flow : r.discharge,
  })).filter((r) => r.points.length >= 2);
  // 🔴 2026-11-05：**落库前裁到海岸线**（与渲染路径同一个裁剪、同一个越线常量）。
  //    为什么放在焊接之前：先裁再焊，焊出来的汇流点仍然在陆地上；反过来会把一个
  //    “已经删掉的尾巴”当汇流目标。
  if (typeof opts.isLand === 'function') {
    list = clipPolylinesToCoast(list, opts.isLand, { keepOvershoot: MOUTH_OVERSHOOT }).list;
  }
  // 🔴 2026-11-04：**量化之后要再接一次、再焊一次**。
  //    ① 量化到 0.01 会把“支流端点正好落在干流线上”挪开一丝 → 看起来断头，所以先 snap；
  //    ② 再把量化后新出现的相交切掉 → 落库几何与画出来的几何一致（0 交叉）。
  //    ⚠️ 顺序不能反：先 weld 后 snap 会把刚切好的断面又拉出一小段交叉（实测 83 处）。
  snapRiverTails(list, { spacing: 8, round });
  weldRiverJunctions(list, { spacing: 8, round });

  return list.map((r) => ({
    id: r.id,
    name: r.name,
    points: r.points,
    width: r.width,
    discharge: r.discharge,
  }));
}

/** 分位（升序取第 q 分位） */
export function quantile(values, q) {
  if (!values.length) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(a.length * q)));
  return a[idx];
}

/**
 * 河宽：**连续映射**（FMG `riverWidth` 的口径）—— 主干粗、支流细，天然分级。
 * 用 sqrt 而非线性：视觉上宽度差更接近"大河水多"的直觉。
 */
export function riverWidth(flux, maxFlux, opts = {}) {
  const min = opts.minWidth == null ? 0.9 : opts.minWidth;
  const max = opts.maxWidth == null ? 7 : opts.maxWidth;
  if (!(maxFlux > 0) || !(flux > 0)) return min;
  const t = Math.min(1, Math.sqrt(flux / maxFlux));
  return min + (max - min) * t;
}

/** 上游 `getSourceWidth`：源头宽度（0 ~ MAX_FLUX_WIDTH） */
export function getSourceWidth(flux, fluxMax) {
  const f = fluxMax > 0 ? flux / fluxMax : 0;
  return Math.min(Math.min(f ** 0.9, 1) * WIDTH.MAX_FLUX_WIDTH, WIDTH.MAX_FLUX_WIDTH);
}

/**
 * 上游 `getOffset`：逐点宽度偏移。
 * `fluxWidth` 走汇流量，`lengthWidth` 走**到源头的点数**（上游的 LENGTH_PROGRESSION 是
 * 斐波那契数列 /200 —— 它让"河越往下游越宽"这件事即使汇流量不变也持续发生）。
 */
export function getOffset({ flux, pointIndex, widthFactor = 1, startingWidth = 0, fluxMax = 0 }) {
  if (pointIndex <= 0) return startingWidth;
  const f = fluxMax > 0 ? Math.min(flux / fluxMax, 1) : 0;
  const fluxWidth = Math.min(f ** 0.7, 1) * WIDTH.MAX_FLUX_WIDTH;
  const lengthWidth = pointIndex * WIDTH.LENGTH_STEP_WIDTH
    + (WIDTH.LENGTH_PROGRESSION[pointIndex] != null
      ? WIDTH.LENGTH_PROGRESSION[pointIndex]
      : WIDTH.LENGTH_PROGRESSION[WIDTH.LENGTH_PROGRESSION.length - 1]);
  return widthFactor * (lengthWidth + fluxWidth) + startingWidth;
}

/** 上游 `getWidth`：偏移 → 河口宽度（相对量纲；渲染侧再按全图归一化成屏幕像素） */
export function widthFromOffset(offset) {
  return Math.pow(Math.max(0, offset) / 1.5, 1.8);
}

/**
 * 折线平滑（2026-11-04）：格网上的河是 8 方向折线，插完控制点仍有 45°/90° 硬拐角 ——
 * 近看就是“电路板”。做 N 遍 [0.25, 0.5, 0.25] 移动平均：
 *   · **点数不变** ⇒ `anchorIndices` 仍然有效，逐点 flux/河宽映射不用重算；
 *   · 两个端点钉住 ⇒ 源头/河口不会被拉离位置。
 */
function smoothPolyline(points, passes) {
  const n = Array.isArray(points) ? points.length : 0;
  const k = Math.max(0, Math.min(6, Math.floor(passes)));
  if (n < 3 || !k) return points;
  for (let p = 0; p < k; p++) {
    const prev = points.map((q) => [q[0], q[1]]);
    for (let i = 1; i < n - 1; i++) {
      points[i][0] = prev[i - 1][0] * 0.25 + prev[i][0] * 0.5 + prev[i + 1][0] * 0.25;
      points[i][1] = prev[i - 1][1] * 0.25 + prev[i][1] * 0.5 + prev[i + 1][1] * 0.25;
    }
  }
  return points;
}

/**
 * 上游 `meander`：在两个格心之间插**垂直偏移的控制点**，河才"弯"。
 * 逐字抄自 `path-utils.ts`（含 `step` 递推、`dist2 <= 25` 跳过、以及
 * `isWaterCell` 时振幅 ×0.25 —— 湖/海面上的弯要收敛，否则河在湖里扭成麻花）。
 *
 * @param {Array<[number,number]>} anchors 格心（或 -1 已由调用方剔除）
 * @param {{spacing?:number, isWater?:boolean[], meandering?:number, phase?:number}} [opts]
 * @returns {{points:Array<[number,number]>, anchorIndices:number[]}}
 */
/** 按河 id 的**确定性**相位（0..1）：同图每次构建一致，但相邻河不同步摆动
 *  —— 相邻平行河若同相位，画面上就是“梳子/田垄”；错开才会散成辫状。 */
function riverPhase(id) {
  const h = Math.imul((((id | 0) ^ 0x9e3779b9) >>> 0), 2654435761) >>> 0;
  return (h % 997) / 997;
}

export function meander(anchors, opts = {}) {
  const src = Array.isArray(anchors) ? anchors : [];
  const out = { points: [], anchorIndices: [] };
  if (src.length < 2) return out;
  const spacing = Number.isFinite(opts.spacing) && opts.spacing > 0 ? opts.spacing : 4;
  const meandering = Number.isFinite(opts.meandering) ? opts.meandering : 1;
  const isWater = Array.isArray(opts.isWater) ? opts.isWater : null;
  // 🔴 2026-11-04 第二十三修（N1，暮雨给截图拍的板：192 档“树枝状”正常，512 档是“海百合上岸”）。
  //    病根是**量纲**：以前横向偏移 = `mv · spacing/4` ⇒ 振幅 ≈ 0.13×格距（192 档只有 1.2 世界单位），
  //    而且每个格心段只插一个偏移点 —— 一条 4 格的河总共 2 个弯，画出来必然是直线
  //    （实测直线度中位 0.969）。现在按**弧长重采样**：每 ~spacing/3 世界单位一个点，
  //    横向是连续的**正弦**（波长按世界单位 ≈1.8×格距），两端振幅收到 0
  //    （源头/河口必须留在格心上：焊接、入海口判定都靠它）。
  //    相位由河 id 决定（确定性，不用随机）：相邻平行河同步摆动就会摆成“梳子/田垄”。
  const cum = new Array(src.length);
  cum[0] = 0;
  for (let i = 1; i < src.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]);
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) {
    out.points = src.map((p) => [p[0], p[1]]);
    out.anchorIndices = src.map((_, i) => i);
    return out;
  }
  const STEP = Math.max(1.2, Math.min(4, spacing / 3));
  // 波长/振幅都按**世界单位**，并且**少而大**：真实河是“一条河两三个大弯”，
  // 不是“一条河十几个碎抖”。实测（2026-11-04）：`spacing*1.8` 波长 + 0.22 倍振幅
  // 画出来是“神经质细波浪”，反而更像贴图。
  const LAMBDA0 = Math.max(12, Math.min(42, spacing * 3.2));
  const ampBase0 = Math.max(1.5, Math.min(5.0, spacing * 0.45)) * meandering;
  const phase = Number.isFinite(opts.phase) ? opts.phase : 0;
  // 每一条河自己的波长/振幅（都由 phase 派生，**仍然确定性**）：
  // 全场同一个波长 + 同一个振幅 = 一排“弹簧”，比直线更像贴图（第一版 v2 就是这个毛病）。
  const PHI = (phase * 2 * Math.PI);
  const LAMBDA = LAMBDA0 * (0.65 + 0.7 * phase);
  const ampScale = 0.6 + 0.8 * ((phase * 7.31) % 1);
  const nStep = Math.max(2, Math.round(total / STEP));
  const ds = total / nStep;

  /** 弧长 s 处的位置与单位切线 */
  const at = (s) => {
    let i = 0;
    while (i + 2 < src.length && cum[i + 1] < s) i++;
    const segLen = (cum[i + 1] - cum[i]) || 1e-9;
    const t = Math.max(0, Math.min(1, (s - cum[i]) / segLen));
    const a = src[i], b = src[i + 1];
    return {
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      dx: (b[0] - a[0]) / segLen,
      dy: (b[1] - a[1]) / segLen,
      seg: i,
    };
  };

  for (let k = 0; k <= nStep; k++) {
    const s = k * ds;
    const p = at(s);
    // 两端 taper 到 0：源头/河口钉在格心上，中间才有弯
    const taper = Math.min(1, s / LAMBDA, (total - s) / LAMBDA);
    // 真实河越往下游越弯：振幅随弧长抬升（0.55 → 1.45），再叠一个二次谐波打散“弹簧感”
    const grow = 0.55 + 0.9 * (total > 0 ? s / total : 0);
    const theta = (2 * Math.PI * s) / LAMBDA + PHI;
    const wave = Math.sin(theta) + 0.35 * Math.sin(2.3 * theta + PHI * 1.7);
    let amp = ampBase0 * ampScale * grow * wave * Math.max(0, taper);
    if (isWater && (isWater[p.seg] || isWater[p.seg + 1])) amp *= MEANDER.WATER_MEANDER_SCALE;
    out.points.push([p.x - p.dy * amp, p.y + p.dx * amp]);   // 左法线方向偏移
  }
  // 锚点 → 采样点索引（单调，供逐点 flux/河宽沿用“上游同一个锚点”的口径）
  let lastIdx = 0;
  for (let i = 0; i < src.length; i++) {
    let idx = Math.round(cum[i] / ds);
    idx = Math.max(lastIdx, Math.min(nStep, idx));
    out.anchorIndices.push(idx);
    lastIdx = idx;
  }
  relaxAcuteAngles(out.points, out.anchorIndices);
  // 只过 1 遍平滑：2 遍会把刚摆出来的弯抹平（第一版就是这么“改了等于没改”的）
  smoothPolyline(out.points, opts.smoothPasses == null ? 1 : opts.smoothPasses);
  return out;
}

/** 点积夹角余弦（只关心锐角 → 返回 max(cos, 0)） */
function cornerCos(a, b, c) {
  const ax = a[0] - b[0], ay = a[1] - b[1];
  const cx = c[0] - b[0], cy = c[1] - b[1];
  const la = Math.hypot(ax, ay), lc = Math.hypot(cx, cy);
  if (la === 0 || lc === 0) return -1;
  return (ax * cx + ay * cy) / (la * lc);
}

function reflectAcrossLine(m, p, q) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [m[0], m[1]];
  const t = ((m[0] - p[0]) * dx + (m[1] - p[1]) * dy) / len2;
  const fx = p[0] + t * dx, fy = p[1] + t * dy;
  return [2 * fx - m[0], 2 * fy - m[1]];
}

/**
 * 上游 `relaxAcuteAngles`：meander 插出来的偏移点会在急弯处造出**尖角**（"钩子"），
 * 逐个把造成锐角的偏移点沿基准线镜像到另一侧，直到不再变好（≤4 轮）。
 */
function relaxAcuteAngles(points, anchorIndices) {
  const n = points.length;
  if (n < 3) return;
  const isAnchor = new Uint8Array(n);
  for (const idx of anchorIndices) isAnchor[idx] = 1;
  const prevAnchor = new Int32Array(n).fill(-1);
  const nextAnchor = new Int32Array(n).fill(-1);
  for (let i = 0, last = -1; i < n; i++) { prevAnchor[i] = last; if (isAnchor[i]) last = i; }
  for (let i = n - 1, last = -1; i >= 0; i--) { nextAnchor[i] = last; if (isAnchor[i]) last = i; }

  const acuteCost = (pos, i) => {
    if (i <= 0 || i >= n - 1) return 0;
    return Math.max(cornerCos(pos(i - 1), pos(i), pos(i + 1)), 0);
  };

  for (let iter = 0; iter < MEANDER.RELAX_ITERATIONS; iter++) {
    const snapshot = points.map((p) => [p[0], p[1]]);
    const at = (k) => snapshot[k];
    let flippedAny = false;
    for (let i = 1; i < n - 1; i++) {
      if (isAnchor[i]) continue;
      const p = prevAnchor[i], q = nextAnchor[i];
      if (p < 0 || q < 0) continue;
      const flipped = reflectAcrossLine(snapshot[i], snapshot[p], snapshot[q]);
      const withFlip = (k) => (k === i ? flipped : snapshot[k]);
      const before = acuteCost(at, i - 1) + acuteCost(at, i) + acuteCost(at, i + 1);
      const after = acuteCost(withFlip, i - 1) + acuteCost(withFlip, i) + acuteCost(withFlip, i + 1);
      if (after < before - 1e-6) {
        points[i][0] = flipped[0];
        points[i][1] = flipped[1];
        flippedAny = true;
      }
    }
    if (!flippedAny) break;
  }
}

/**
 * 湖格索引：`hm.lakes = [{level, cells}]` → `{ lakeOf: Int32Array, lakes: [{id, cells, level}] }`。
 * 没有 `hm.lakes` 就是空表（行为与"没有湖"完全一致）。
 */
function indexLakes(hm, n) {
  const lakeOf = new Int32Array(n).fill(-1);
  const lakes = [];
  const src = Array.isArray(hm && hm.lakes) ? hm.lakes : [];
  for (let k = 0; k < src.length; k++) {
    const lk = src[k];
    const cells = (lk && Array.isArray(lk.cells)) ? lk.cells : [];
    if (cells.length < 4) continue;
    const id = lakes.length;
    const kept = [];
    for (const i of cells) {
      if (!Number.isInteger(i) || i < 0 || i >= n || lakeOf[i] >= 0) continue;
      lakeOf[i] = id;
      kept.push(i);
    }
    if (kept.length >= 4) lakes.push({ id, cells: kept, level: Number(lk.level) || 0 });
  }
  return { lakeOf, lakes };
}

/**
 * 建河网（FMG 的 `drainWater` + `defineRivers`）。
 *
 * @param {{h:ArrayLike<number>, grid:{points:Array,cellsX:number,cellsY:number,spacing:number}, prec?:ArrayLike<number>, lakes?:Array}} hm
 * @param {{seaLevel?:number, minFlux?:number, minCells?:number, meandering?:number, cellModifier?:number}} [opts]
 * @returns {{rivers:Array, segments:Array, stats:object}}
 */
export function buildRiverNetwork(hm, opts = {}) {
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const minCells = Math.max(2, Math.floor(Number.isFinite(opts.minCells) ? opts.minCells : MIN_RIVER_CELLS));
  const cols = hm && hm.grid ? (hm.grid.cellsX | 0) : 0;
  const rows = hm && hm.grid ? (hm.grid.cellsY | 0) : 0;
  const pts = hm && hm.grid ? hm.grid.points : null;
  const hRaw = hm && hm.h;
  const n = cols * rows;
  if (!(cols > 1 && rows > 1) || !pts || !hRaw || hRaw.length !== n) {
    return { rivers: [], segments: [], stats: { reason: 'no-grid' } };
  }
  const spacing = Number(hm.grid.spacing) || 4;
  // 降水（FMG 的 flux 权重）。⚠️ 全 0 的 `prec` 数组 = **还没派生气候**（`createBaseMapHeightmap`
  // 会把 temp/prec 初始化为 0）—— 那种情况按"均匀降雨"算，否则一条河都长不出来
  // （实测：直接写好高度图再点自动河流 → 0 条，用户只会以为这个按钮坏了）。
  let prec = (hm.prec && hm.prec.length === n) ? hm.prec : null;
  if (prec) {
    let precMax = 0;
    for (let i = 0; i < n; i++) {
      const v = prec[i];
      if (v > precMax) { precMax = v; if (precMax > 1e-6) break; }
    }
    if (!(precMax > 1e-6)) prec = null;
  }
  const fluxMaxRef = Number.isFinite(opts.fluxMax) && opts.fluxMax > 0 ? opts.fluxMax : 0;
  // 与上游一致：降水按"格点数的 1/4 次方"归一，保证不同分辨率的汇流量同量纲
  const cellModifier = Number.isFinite(opts.cellModifier) && opts.cellModifier > 0
    ? opts.cellModifier
    : Math.max(0.2, Math.pow(n / 10000, 0.25));
  const minFluxOpt = Number.isFinite(opts.minFlux)
    ? Math.max(0, opts.minFlux)
    : MIN_FLUX_TO_FORM_RIVER;
  // 阈值口径（2026-11-04，P3）：`minFlux` 是“汇流计数 × 降水”的任意单位，换格数就得重调
  // （96 / 256 / 24k 三档的“河数 / 万格陆地”会飘）。`minDrainageArea`（世界单位²）把阈值换成
  // **流域面积**：每格贡献 `meanPrec / cellModifier` 个 flux 单位、占 `spacing²` 面积
  //   → 1 个 flux 单位 ≈ spacing² · cellModifier / meanPrec（面积）。
  // 不传 `minDrainageArea` 时行为一字不变（`minFlux` 原样使用）。
  const areaThreshold = Number.isFinite(opts.minDrainageArea) && opts.minDrainageArea > 0
    ? opts.minDrainageArea
    : 0;
  let minFlux = minFluxOpt;
  if (areaThreshold > 0) {
    let meanPrec = 50;
    if (prec) {
      let sum = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        if (hRaw[i] < seaLevel) continue;
        sum += prec[i];
        cnt++;
      }
      if (cnt) meanPrec = Math.max(1e-6, sum / cnt);
    }
    const areaPerFlux = (spacing * spacing) * cellModifier / meanPrec;
    minFlux = areaThreshold / Math.max(1e-9, areaPerFlux);
  }
  // 河源判据（2026-11-04）：海边平地只要汇流量过闸也会起河 → 一片碎沟。
  // `minSourceRise`（高度点）= 源头必须高出海面多少；0 = 关（老行为逐字节不变）。
  const minSourceRise = Number.isFinite(opts.minSourceRise)
    ? Math.max(0, Number(opts.minSourceRise))
    : 0;

  const { lakeOf, lakes } = indexLakes(hm, n);
  // ── ⓪ 排水面（2026-11-04）：上游 FMG 在 `generate()` 里自己跑 `resolveDepressions`，
  //    我们的合成地形也已经填过洼地；但**手画/导入的高度图**可能带封闭盆地。
  //    这里做同一件事（复用仓内唯一的 priority-flood 实现），并如实回报填了几格：
  //    不填的话，水流到盆底就"没有更低的邻居" → 河道在半路消失（本项目明令禁止的形态）。
  let heights = Float64Array.from(hRaw);
  // 追踪前平滑（面板上那个"平滑"勾选框）：在高频噪声重的图上，格级小丘会把一条河切成
  // 几十段（每个小丘一个源头）。3×3 箱式滤波跑 N 遍 —— 只用于**路由**，不动用户的 h。
  const smoothPasses = Math.max(0, Math.min(4, Math.floor(Number(opts.smoothPasses) || 0)));
  if (smoothPasses > 0) {
    for (let pass = 0; pass < smoothPasses; pass++) {
      const src = heights;
      const out = new Float64Array(n);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let sum = 0, cnt = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const cc = c + di, rr = r + dj;
              if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
              sum += src[rr * cols + cc];
              cnt++;
            }
          }
          out[r * cols + c] = cnt ? sum / cnt : src[r * cols + c];
        }
      }
      heights = out;
    }
  }
  let down = downslope(heights, cols, rows);
  let stalled = 0;
  for (let i = 0; i < n; i++) {
    if (heights[i] < seaLevel) continue;
    const d = down[i];
    if (d < 0 || heights[i] <= heights[d]) stalled++;
  }
  let refilled = 0;
  if (stalled > 0) {
    let hi = 0;
    for (let i = 0; i < n; i++) if (heights[i] > hi) hi = heights[i];
    const landMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) landMask[i] = heights[i] >= seaLevel ? 1 : 0;
    const eps = Math.max(1e-3, (hi - seaLevel) / 2000);
    heights = fillDepressions(heights, landMask, cols, rows, seaLevel, eps);
    down = downslope(heights, cols, rows);
    refilled = stalled;
  }
  // 以下一律用**排水面**（填平后）：`h` 是这一步之后的别名，别再摸 `hRaw`。
  const h = heights;

  // ── ① 汇流量：**降水当量**（FMG：`cells.fl[i] += prec / modifier`）────────────────
  // 上一版用"每格 1 + 分位闸门"，与气候无关 —— 撒哈拉和雨林长一样多。这里直接抄上游：
  // 雨多的格子贡献大，干旱格子贡献小；再把 flux 累进下游。
  const fl = new Float64Array(n);
  const r = new Int32Array(n).fill(0);          // 格子 → 河 id（0 = 没有）
  const conf = new Float64Array(n);             // 汇流点标记（上游 `cells.conf`）
  const riversData = new Map();                 // id → cells[]
  const riverParents = new Map();               // id → 下游河 id
  const lakeInlets = new Map();                 // 湖 id → 进水河 id[]
  const lakeOutletRiver = new Map();            // 湖 id → 出口河 id
  let nextId = 1;
  const addCell = (cell, riverId) => {
    if (cell < 0) return;
    const arr = riversData.get(riverId);
    if (arr) arr.push(cell);
    else riversData.set(riverId, [cell]);
  };
  const isWater = (i) => h[i] < seaLevel || lakeOf[i] >= 0;
  const borderCell = (i) => {
    const c = i % cols, rr = (i - c) / cols;
    return c === 0 || rr === 0 || c === cols - 1 || rr === rows - 1;
  };
  const lakeAt = (i) => (i >= 0 && lakeOf[i] >= 0 ? lakes[lakeOf[i]] : null);
  /** 湖的"出口格"：湖内格子中，下游已经不在湖里的那些（按水位从低到高） */
  const lakeOutlets = new Map();                // lake.id → cell
  const lakeFeedsCell = new Map();              // 湖出口下游的陆格 → lake.id
  for (const lk of lakes) {
    let best = -1, bestH = Infinity;
    for (const i of lk.cells) {
      const d = down[i];
      if (d < 0) continue;
      if (lakeOf[d] === lk.id) continue;
      if (h[i] < bestH) { bestH = h[i]; best = i; }
    }
    if (best >= 0) {
      lakeOutlets.set(lk.id, best);
      const out = down[best];
      if (out >= 0 && lakeOf[out] < 0 && h[out] >= seaLevel) {
        // 一个陆格只记一座湖（多湖共用出口时取水位更低的那座）
        if (!lakeFeedsCell.has(out)) lakeFeedsCell.set(out, lk.id);
      }
    }
  }

  // ── ② 排水（上游 `drainWater`）──────────────────────────────────────────────
  // ⚠️ 顺序是**高度从高到低**：这是"水只往下流、一次就能算完"的前提。
  const land = [];
  for (let i = 0; i < n; i++) if (h[i] >= seaLevel && !borderCell(i)) land.push(i);
  land.sort((a, b) => h[b] - h[a]);

  const ownsFlux = (i) => (prec ? Math.max(0, prec[i]) : 50) / cellModifier;

  /** 上游 `flowDown`：把一条河的水交给下游格，并在汇流处决定"谁吞谁" */
  const flowDown = (toCell, fromFlux, riverId) => {
    if (toCell < 0) return;
    const toFlux = fl[toCell] - conf[toCell];
    const toRiver = r[toCell];
    if (toRiver) {
      if (fromFlux > toFlux) {
        conf[toCell] += fl[toCell];          // 记为汇流点
        if (h[toCell] >= seaLevel) riverParents.set(toRiver, riverId);  // 下游那条降为支流
        r[toCell] = riverId;                 // 这一段归上游那条（主干继续往下走）
      } else {
        conf[toCell] += fromFlux;
        if (h[toCell] >= seaLevel) riverParents.set(riverId, toRiver);  // 我们是支流
      }
    } else {
      r[toCell] = riverId;
    }
    if (h[toCell] < seaLevel) {
      // 入海：这条河到此为止（`mouth` 在 defineRivers 里取倒数第二格 = 最后一个陆格）
    } else if (lakeOf[toCell] >= 0) {
      const lk = lakeAt(toCell);
      if (lk) {
        const list = lakeInlets.get(lk.id);
        if (list) list.push(riverId);
        else lakeInlets.set(lk.id, [riverId]);
        fl[toCell] += fromFlux;               // 湖里继续攒水（湖格不画河，但水要往下走）
      }
    } else {
      fl[toCell] += fromFlux;
    }
    addCell(toCell, riverId);
  };

  for (const i of land) {
    fl[i] += ownsFlux(i);
    // 湖格：不画河、不另起河号，只把水往下游灌（出口格最后处理 → 汇流量已经齐了）
    if (lakeOf[i] >= 0) {
      const d = down[i];
      if (d >= 0 && h[d] < seaLevel) continue;          // 湖水直接入海：不占河道
      if (d >= 0 && lakeOf[d] >= 0) fl[d] += fl[i];      // 湖内传递
      else if (d >= 0) {
        // 出口格：水推出湖面，交给下游的陆格去"起河"（下一步会读到这份 fl）
        fl[d] += fl[i];
      }
      continue;
    }
    const d = down[i];
    if (d < 0) continue;
    if (h[i] <= h[d]) continue;                          // 洼地（填平后不该有，防御）
    if (fl[i] < minFlux) {
      if (h[d] >= seaLevel) fl[d] += fl[i];              // 还成不了河：水照样往下走
      continue;
    }
    if (!r[i]) {
      r[i] = nextId;
      addCell(i, nextId);
      // 出口河：这个格子正是某座湖的出口下游 → 父河 = 湖的主要进水河
      // （这样"上游河 → 湖 → 下游河"在分级/河名上仍然是一条链，不会断在湖里）
      const fedBy = lakeFeedsCell.get(i);
      if (fedBy != null) {
        const inlets = lakeInlets.get(fedBy) || [];
        let main = 0, mainFlux = -1;
        for (const id of inlets) {
          const cells = riversData.get(id) || [];
          const f = cells.length ? fl[cells[cells.length - 1]] : 0;
          if (f > mainFlux) { mainFlux = f; main = id; }
        }
        if (main) riverParents.set(nextId, main);
        lakeOutletRiver.set(fedBy, nextId);
      }
      nextId++;
    }
    flowDown(d, fl[i], r[i]);
  }

  // ── ③ 成河（上游 `defineRivers`）──────────────────────────────────────────────
  //   · 少于 `minCells` 的河丢掉（"短棍"的结构性保证）；
  //   · 保住 id 的河，把它自己的格子标成自己的（重叠格 = 汇流点）；
  //   · 河宽按 `getOffset` 逐点算（源头细、河口粗，且随点数继续变粗）。
  const kept = [];
  for (const [id, cells] of riversData) {
    if (!cells || cells.length < minCells) continue;
    kept.push({ id, cells: cells.slice() });
  }
  const keptIds = new Set(kept.map((k) => k.id));
  // 父河被丢掉（太短）→ 挂到最近一个还活着的祖先上（否则分级/河名断在这里）
  const resolveParent = (id) => {
    let cur = riverParents.get(id) || 0;
    const seen = new Set([id]);
    while (cur && !keptIds.has(cur) && !seen.has(cur)) { seen.add(cur); cur = riverParents.get(cur) || 0; }
    return cur && cur !== id ? cur : 0;
  };

  const fluxOf = new Float64Array(n);
  for (let i = 0; i < n; i++) fluxOf[i] = fl[i];
  let maxFlux = 0;
  for (let i = 0; i < n; i++) {
    if (h[i] >= seaLevel && fluxOf[i] > maxFlux) maxFlux = fluxOf[i];
  }
  const fluxMax = fluxMaxRef || maxFlux || 1;

  const byId = new Map();
  for (const { id, cells } of kept) {
    const clean = cells.filter((c) => c >= 0);
    if (clean.length < minCells) continue;
    // 源头太贴海 = 山脚/滩地上的碎沟，不画（水照样往下游走，只是不画这一截）
    if (minSourceRise > 0 && h[clean[0]] - seaLevel < minSourceRise) continue;
    const source = clean[0];
    const last = clean[clean.length - 1];
    const endInSea = h[last] < seaLevel;
    const endInLake = !endInSea && lakeOf[last] >= 0;
    // 河口 = 最后一个陆格（上游 `mouth = cells[len-2]` 的同一条口径：末格是水面）
    const mouth = (endInSea || endInLake) && clean.length >= 2 ? clean[clean.length - 2] : last;
    const parent = resolveParent(id);
    const waterFlags = clean.map((c) => h[c] < seaLevel || lakeOf[c] >= 0);
    const anchors = clean.map((c) => [pts[c][0], pts[c][1]]);
    // 相位按 ra河 id 确定性哈希（不用随机）：相邻平行河不同步摆动，才不会摆成'梳子/'田垄'。
    const md = meander(anchors, { spacing, isWater: waterFlags, meandering: opts.meandering, phase: riverPhase(id) });
    // 逐点 flux：锚点取该格的汇流量，meander 插的点沿用上一个锚点（上游 addMeandering 同口径）
    const flows = new Array(md.points.length).fill(0);
    md.anchorIndices.forEach((pointIndex, anchorIndex) => {
      const cell = clean[anchorIndex];
      flows[pointIndex] = fluxOf[cell] || 0;
    });
    for (let k = 0; k < flows.length; k++) if (!flows[k]) flows[k] = k > 0 ? flows[k - 1] : 0;
    // 河口宽度（相对量纲）
    const widthFactor = (!parent || parent === id) ? 1.2 : 1;
    const sourceWidth = getSourceWidth(fluxOf[source], fluxMax);
    const discharge = fluxOf[mouth];
    const mouthOffset = getOffset({
      flux: discharge, pointIndex: md.points.length - 1, widthFactor, startingWidth: sourceWidth, fluxMax,
    });
    const width = widthFromOffset(mouthOffset);
    const endAtEdge = !endInSea && !endInLake && borderCell(last);
    byId.set(id, {
      id, cells: clean,
      source, mouth,
      parent,
      basin: 0,                                  // 下面按 parent 链回填
      order: 1,                                  // 下面按 Strahler 回填
      length: 0,
      discharge,
      // `flow` 是渲染/用例那边的旧字段名（线宽分级按它归一）—— 与 `discharge` 同值，
      // 保留是为了不把"改引擎"变成"改所有消费方"。
      flow: discharge,
      width,
      sourceWidth,
      widthFactor,
      points: md.points.map(([x, y], k) => ({ x, y, flux: flows[k] })),
      endInSea,
      endInLake,
      lakeId: endInLake ? lakeOf[last] : -1,
      endAtEdge,
    });
  }

  // ── ③.5 汇流焊接（2026-11-04，暮雨：“那些过穿的河流是否无法解决？”）──────────────
  // 河是**格心 + D8** 的折线：两条河走对角相邻的两格时，连线会在 2×2 方格中间交叉，
  // 再加 meander / relax 的横向位移，实测真实底图 4498 段里有 **71 处 X 交叉**
  // （`scripts/tests/tools/audit_river_crossings.js` 可复算）。
  // 这里做一次拓扑收口：按 discharge 从大到小建“已接受集合”，每条支流在**第一次与更大河
  // 相交处**截断、补上交点、parent 指向那条河 —— X 变 Y，且截断点就在干流线上，看起来是汇流。
  // 先接尾巴（不相交但也没接上的），再焊接（切掉相交的），最后再补一次缝：
  // 顺序反了会在“把尾巴拉到干流上”这一步重新制造交叉。
  const snapStats = snapRiverTails(Array.from(byId.values()), { spacing });
  const weld = weldRiverJunctions(Array.from(byId.values()), { spacing });
  // 第三刀：**真断头**（既没入海、也没入湖、也没汇进别人）—— 把尾巴接到最近的河上，
  // 允许 14 个世界单位（约 1.5 格）。实测真实项目：122 条内陆断头里，前两刀收掉 93 条，
  // 剩下的都是“parent 太远（>6）”或 parent 已被裁掉的那种。
  snapRiverTails(Array.from(byId.values()), { spacing, maxGap: 14, onlyDeadEnds: true, ignoreParent: true });

  // ── ③.6 尾巴落回 cells（2026-11-05）──────────────────────────────────────────
  // 🔴 snapRiverTails / weldRiverJunctions 只改 `points`，**不动 `cells`** ——
  //    于是“几何上已经接在干流上”的支流，`cells` 的末格还停在旧位置：
  //    test_103 判成 detached（12/16），导出/统计也读不到汇流点。
  //    这里只补**宿主那一格**（与上游 flowDown 的口径一致：汇流点同属两条河），
  //    **不动 mouth/discharge** —— 支流的 discharge 是它自己的水，用宿主的格会把它吹胖。
  {
    let patched = 0;
    for (const r of byId.values()) {
      if (r.endInSea || r.endInLake || r.endAtEdge) continue;
      if (!r.parent) continue;
      const host = byId.get(r.parent);
      if (!host || !Array.isArray(host.cells) || !host.cells.length) continue;
      const pts0 = r.points || [];
      if (pts0.length < 2) continue;
      const tail = pts0[pts0.length - 1];
      const lastCell = r.cells[r.cells.length - 1];
      const hLast = Number.isFinite(h[lastCell]) ? h[lastCell] : Infinity;
      let hostCell = -1;
      let bestD = Infinity;
      for (const c of host.cells) {
        const p = pts[c];
        if (!p) continue;
        // 🔴 只能接**不高于**自己尾巴那格：水不往高处流（a6 就是守这条的）。
        //    宿主的“最近格”可能落在汇流点的上游侧，直接接上去会造出一段上坡。
        if (Number.isFinite(h[c]) && h[c] > hLast + 1e-6) continue;
        const d = (p[0] - tail.x) * (p[0] - tail.x) + (p[1] - tail.y) * (p[1] - tail.y);
        if (d < bestD) { bestD = d; hostCell = c; }
      }
      // 超过 1.5 格就不算“接上了”（snap 的 maxGap 14 世界单位 ≈ 1.5 格），别硬塞
      if (hostCell < 0 || Math.sqrt(bestD) > spacing * 1.5) continue;
      if (!r.cells.includes(hostCell)) {
        r.cells.push(hostCell);
        patched++;
      }
      r.endsAtJunction = true;
    }
  }
  // 焊接可能把一条“原本没有 parent”的支流挂到某条河上，而那条河原本又挂在它下面（湖进出口
  // 那种双向关系）→ 成环，分级/流域根会走到死循环。这里剪环，并**优先保住焊接出来的边**
  // （有 `endsAtJunction` 的那一端是几何真的断在这里，剪了就会露出一根浮空的棍子）。
  for (const river of byId.values()) {
    const path = [];
    const at = new Map();
    let cur = river;
    let guard = 0;
    while (cur && cur.parent && guard++ < 256) {
      if (at.has(cur.id)) {
        const members = path.slice(at.get(cur.id));
        let victim = members.find((m) => !m.endsAtJunction);
        if (!victim) victim = members.slice().sort((a, b) => (b.id - a.id))[0];
        if (victim) {
          // 剪掉的那条并不是“浮空的棍子”：它的端点仍然落在下游那条河的格子上（汇流点），
          // 只是 parent 链断开 → 打上汇流终点标记，孤段判据认它。
          victim.parent = 0;
          if (!victim.endInSea && !victim.endInLake && !victim.endAtEdge) victim.endsAtJunction = true;
        }
        break;
      }
      at.set(cur.id, path.length);
      path.push(cur);
      cur = byId.get(cur.parent);
    }
  }
  // 父河指向自己 / 已被丢弃 → 主干
  for (const river of byId.values()) {
    if (river.parent && !byId.has(river.parent)) river.parent = 0;
    if (river.parent === river.id) river.parent = 0;
  }
  // （尾巴的接线已上移到焊接之前；这里不再重复）
  // 长度（按线段，与世界单位同量纲）
  for (const river of byId.values()) {
    let len = 0;
    for (let i = 1; i < river.points.length; i++) {
      len += Math.hypot(river.points[i].x - river.points[i - 1].x, river.points[i].y - river.points[i - 1].y);
    }
    river.length = len;
  }
  // ── ④ 分级：Strahler + 流域根（FMG 用 parent/basin 做河名与主/支判定，这里补一个数值等级，
  //      让 UI/河名/线宽都有一条**离散**的主干判据）────────────────────────────────────
  const children = new Map();
  for (const river of byId.values()) {
    if (!river.parent) continue;
    const list = children.get(river.parent);
    if (list) list.push(river.id);
    else children.set(river.parent, [river.id]);
  }
  const orderMemo = new Map();
  const orderOf = (id, guard = 0) => {
    if (orderMemo.has(id)) return orderMemo.get(id);
    if (guard > 64) return 1;
    const kids = children.get(id) || [];
    let best = 0, bestCount = 0;
    for (const kid of kids) {
      const o = orderOf(kid, guard + 1);
      if (o > best) { best = o; bestCount = 1; } else if (o === best) bestCount++;
    }
    const val = kids.length ? (bestCount >= 2 ? best + 1 : best) : 1;
    orderMemo.set(id, val);
    return val;
  };
  const basinOf = (id, guard = 0) => {
    let cur = id;
    const seen = new Set();
    while (guard < 64) {
      const p = byId.get(cur) && byId.get(cur).parent;
      if (!p || seen.has(p)) break;
      seen.add(p);
      cur = p;
    }
    return cur;
  };
  for (const river of byId.values()) {
    river.order = orderOf(river.id);
    river.basin = basinOf(river.id);
  }

  const rivers = Array.from(byId.values()).sort((a, b) => (b.discharge - a.discharge) || (a.id - b.id));

  // ── ⑤ 段（兼容层）：渲染/裁剪/命中/case 都还认 `{x0,y0,x1,y1,flow,endInSea}` ────────
  // 段的来源改成"河的点列"（含 meander），于是**段与河不可能各画各的**（同一份几何）。
  const segments = [];
  let maxOrder = 1;
  for (const river of rivers) {
    if (river.order > maxOrder) maxOrder = river.order;
    const ps = river.points;
    for (let k = 1; k < ps.length; k++) {
      const a = ps[k - 1], b = ps[k];
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) continue;
      segments.push({
        x0: a.x, y0: a.y, x1: b.x, y1: b.y,
        flow: b.flux || a.flux || 1,
        flux: b.flux || a.flux || 1,
        order: river.order,
        riverId: river.id,
        endInSea: k === ps.length - 1 && river.endInSea,
        endInLake: k === ps.length - 1 && river.endInLake,
      });
    }
  }

  return {
    rivers,
    segments,
    stats: {
      cols, rows,
      land: land.length,
      lakes: lakes.length,
      lakeCells: lakeOf.reduce((acc, v) => acc + (v >= 0 ? 1 : 0), 0),
      count: rivers.length,
      segments: segments.length,
      maxFlux: fluxMax,
      maxDischarge: rivers.length ? rivers[0].discharge : 0,
      maxOrder,
      minFlux,
      cellModifier: Math.round(cellModifier * 1000) / 1000,
      minCells,
      // 排水面自检：`stalled` = 没有更低下游的陆格数，`refilled` = 因此被重新填平的格数。
      // 产品传进来的高度图本来就已经填过（合成地形）→ 两个数都是 0；手画/导入的图才非 0。
      stalled, refilled,
      endInSea: rivers.filter((r2) => r2.endInSea).length,
      endInLake: rivers.filter((r2) => r2.endInLake).length,
      // 汇流焊接：`cut` = 被截断的支流数，`joined` = 因此新挂上 parent 的条数（0 = 本来就没交叉）
      welded: weld.cut,
      weldedJoined: weld.joined,
      // 汇流点去重：同一个主干上被挪开下游的支流数（2026-11-04 第二十一修）
      declumped: weld.declumped || 0,
      snapped: snapStats.snapped,
    },
  };
}

/**
 * **把支流的尾巴接到干流的“画出来的线”上**（2026-11-04，暮雨：“河流中断，各画各的，并不真的相连”）。
 *
 * 为什么光焊不够：焊接只在两条线**真的相交**时才截断；而引擎给的支流尾点是**自己的末格格心**，
 * 干流的折线经过 meander / 平滑之后，可能从那个格心旁边 0.5~2.5 个单位掠过 ——
 * 两支线不相交、也不相接，画面上就是“断头”。实测真实项目：573 条里 **122 条**尾巴悬在内陆空中
 * （离别的河 >0.8 单位、离海 >2 格）。
 *
 * 口径：
 *   · 只动**尾点**（源头本来就该悬在山里）；
 *   · 有 parent 时：接到 parent 的折线上（允许 6 个世界单位的间隙）；
 *   · 没有 parent（落库形状/渲染曲线）：只接 1.2 单位以内的近邻，避免把平行河错接；
 *   · 距离 0 表示本来就接上了，不动。
 *
 * @param {Array<{id:number|string, points:Array<{x:number,y:number}>, parent?:number}>} rivers
 * @param {{maxGap?:number, maxParentGap?:number}} [opts]
 * @returns {{snapped:number}}
 */
export function snapRiverTails(rivers, opts = {}) {
  const list = Array.isArray(rivers) ? rivers : [];
  const maxGap = Number.isFinite(opts.maxGap) ? opts.maxGap : 1.2;
  const maxParentGap = Number.isFinite(opts.maxParentGap) ? opts.maxParentGap : 6;
  const cell = Math.max(2, Number(opts.spacing) > 0 ? Number(opts.spacing) : 8);
  const grid = new Map();
  const index = (r) => {
    const pts = r.points || [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = gx + ',' + gy;
          const arr = grid.get(k);
          if (arr) arr.push({ rid: r.id, a, b });
          else grid.set(k, [{ rid: r.id, a, b }]);
        }
      }
    }
  };
  for (const r of list) index(r);
  let snapped = 0;
  const onlyDeadEnds = opts.onlyDeadEnds === true;
  const ignoreParent = opts.ignoreParent === true;
  for (const r of list) {
    const pts = r.points || [];
    if (pts.length < 2) continue;
    if (onlyDeadEnds && (r.endInSea || r.endInLake || r.endsAtJunction)) continue;
    const tail = pts[pts.length - 1];
    const reach = (r.parent && !ignoreParent) ? maxParentGap : maxGap;
    const gx0 = Math.floor((tail.x - reach) / cell), gx1 = Math.floor((tail.x + reach) / cell);
    const gy0 = Math.floor((tail.y - reach) / cell), gy1 = Math.floor((tail.y + reach) / cell);
    let best = { d: Infinity, x: 0, y: 0, rid: null };
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const arr = grid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const cand of arr) {
          if (cand.rid === r.id) continue;
          const dx = cand.b.x - cand.a.x, dy = cand.b.y - cand.a.y;
          const L = dx * dx + dy * dy;
          if (!L) continue;
          const u = Math.max(0, Math.min(1, ((tail.x - cand.a.x) * dx + (tail.y - cand.a.y) * dy) / L));
          const qx = cand.a.x + dx * u, qy = cand.a.y + dy * u;
          const d = Math.hypot(tail.x - qx, tail.y - qy);
          // 有 parent 时只认 parent 的那条；没有 parent 时认最近的（且必须在 maxGap 内）
          if (!ignoreParent && r.parent && cand.rid !== r.parent && d > maxGap) continue;
          if (d < best.d) best = { d, x: qx, y: qy, rid: cand.rid };
        }
      }
    }
    if (!Number.isFinite(best.d) || best.d <= 1e-4) continue;
    const limit = (!ignoreParent && r.parent) ? (best.rid === r.parent ? maxParentGap : maxGap) : maxGap;
    if (best.d > limit) continue;
    // 不要拉得太远：只接最近的这一截（落库时要按同一精度量化，否则 a17 的 2 位小数判据会红）。
    // ⚠️ 收到 **99.5%** 处、而不是精确压到线上：量化（0.01）与浮点会让“刚好压上”变成“越过一丝”，
    //    那就是量出来 83 处“贴着汇流点的交叉”。差 0.005 世界单位（12 倍下 0.03px）看不出来，但几何干净。
    const keep = 0.995;
    const tx = tail.x + (best.x - tail.x) * keep;
    const ty = tail.y + (best.y - tail.y) * keep;
    const rq = Number.isFinite(opts.round) && opts.round >= 0 ? Math.pow(10, Math.floor(opts.round)) : 0;
    tail.x = rq ? Math.round(tx * rq) / rq : tx;
    tail.y = rq ? Math.round(ty * rq) / rq : ty;
    snapped++;
  }
  return { snapped };
}

/**
 * **汇流焊接**（2026-11-04）：把“河与河 X 交叉”收口成“在干流上汇入”。
 *
 * 为什么需要（不是参数问题）：河点落在**格心**、流向是 D8 八方向 —— 两条河走对角相邻的两格时，
 * 两条连线在 2×2 方格正中必然交叉；再叠加 `meander` / `relaxAcuteAngles` 的横向位移与两遍平滑，
 * 交叉会更明显。实测真实项目 573 条河 / 4498 段 = **71 处交叉**（0 处自交）。
 *
 * 口径（三条，改之前先读）：
 *   ① **按 discharge 从大到小**处理：先接受的是干流，后接受的支流在**第一次与已接受河相交**处截断；
 *   ② 截断点用精确交点补一个点（`flux` 沿用该段上游值），所以画出来支流端点**落在干流线上**；
 *   ③ **端点相接不算交叉**（`t/u` 贴边跳过）：那本来就是汇流点，再裁就把下游剪没了。
 *
 * 副作用（有意为之）：被截断的河不再是 `endInSea/endInLake`，`mouth` 改成交点所在格；
 * `parent` 只在不冲突时挂上（已有 parent 的不覆盖，防把汇流链改成环）。
 *
 * @param {Array<{id:number, points:Array<{x:number,y:number,flux?:number}>, cells?:number[],
 *                discharge?:number, parent?:number}>} rivers
 * @param {{spacing?:number}} [opts] 网格边长（世界单位），默认 8
 * @returns {{cut:number, joined:number}} cut = 截断条数；joined = 因此新挂 parent 的条数
 */
export function weldRiverJunctions(rivers, opts = {}) {
  const list = Array.isArray(rivers) ? rivers : [];
  const cellSize = Math.max(2, Number(opts.spacing) > 0 ? Number(opts.spacing) : 8);
  const byId = new Map();
  for (const r of list) byId.set(r.id, r);
  const grid = new Map();
  let cut = 0;
  let joined = 0;
  let declumped = 0;
  // 汇流点去重（见函数末尾的收口一遍）：同一个主干上落在 1.6 世界单位内的汇入，沿主干向下游错开。
  // 取 1.6 而不是 2.8：12 倍下 1.6 单位 ≈ 11px，足够把“四臂星”拆成两个 Y；再大就会在支流
  // 尾段拽出一道明显的折（下游顶点是离散的，跳得越远折得越狠）。
  const declumpGap = Math.max(1.2, cellSize * 0.2);

  /** 线段 a→b 是否**真横穿**任何"已接受"的河段（端点贴边不算：汇流点本来就落在主干上）。
   *  查的是同一个网格索引（= 已处理过的河），所以主干和邻近支流都覆盖到。 */
  const crossesIndexed = (a, b, selfId) => {
    const rx = b.x - a.x, ry = b.y - a.y;
    const EPS = 1e-6;
    const x0 = Math.floor(Math.min(a.x, b.x) / cellSize), x1 = Math.floor(Math.max(a.x, b.x) / cellSize);
    const y0 = Math.floor(Math.min(a.y, b.y) / cellSize), y1 = Math.floor(Math.max(a.y, b.y) / cellSize);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const arr = grid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const cand of arr) {
          if (cand.rid === selfId) continue;
          const sx = cand.b.x - cand.a.x, sy = cand.b.y - cand.a.y;
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-12) continue;
          const qx = cand.a.x - a.x, qy = cand.a.y - a.y;
          const t = (qx * sy - qy * sx) / den;
          const u = (qx * ry - qy * rx) / den;
          if (t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS) return true;
        }
      }
    }
    return false;
  };


  /** 沿折线从 (x,y) 的最近点走 dist，返回落到的**顶点**；走不到就 null。
   *  `dir=+1` 顺流（默认），`dir=-1` 逆流 —— 交汇点常落在主干末端附近，顺流没有下一个顶点，
   *  那时反向错开一样能把四臂星拆开（实测 9/12 的残留就卡在“顺流无路”）。 */
  const advanceToVertex = (pts, x, y, dist, dir = 1) => {
    if (!Array.isArray(pts) || pts.length < 2) return null;
    let bestD = Infinity, bestI = 0, bestU = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
      const qx = a.x + dx * u, qy = a.y + dy * u;
      const d = Math.hypot(x - qx, y - qy);
      if (d < bestD) { bestD = d; bestI = i; bestU = u; }
    }
    // 从最近点出发，按顶点距离累加；够 dist 就返回那个顶点（顶点已在线上，量化不会挪偏）
    let walked = 0;
    let prev = { x: pts[bestI].x + (pts[bestI + 1].x - pts[bestI].x) * bestU,
                 y: pts[bestI].y + (pts[bestI + 1].y - pts[bestI].y) * bestU };
    if (dir >= 0) {
      for (let i = bestI + 1; i < pts.length; i++) {
        const v = pts[i];
        walked += Math.hypot(v.x - prev.x, v.y - prev.y);
        // 顶点是离散的：一段太长时“跳到下一个顶点”会把交界点甩出很远（截断痕迹明显）→ 干脆不动
        if (walked >= dist) return walked > dist * 2.5 ? null : { x: v.x, y: v.y };
        prev = v;
      }
    } else {
      for (let i = bestI; i >= 0; i--) {
        const v = pts[i];
        walked += Math.hypot(v.x - prev.x, v.y - prev.y);
        if (walked >= dist) return walked > dist * 2.5 ? null : { x: v.x, y: v.y };
        prev = v;
      }
    }
    return null;
  };

  /** 挂 parent 前先验环：命中河的 parent 链上若已经有我们，这条边就不能加（湖进出口会出现双向） */
  const wouldCycle = (fromId, toId) => {
    let cur = toId;
    let guard = 0;
    while (cur && guard++ < 256) {
      if (cur === fromId) return true;
      const r = byId.get(cur);
      cur = r ? r.parent : 0;
    }
    return false;
  };

  const crossAt = (a, b, c, d) => {
    const rx = b.x - a.x, ry = b.y - a.y;
    const sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const qx = c.x - a.x, qy = c.y - a.y;
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    // 端点贴边不算交叉（那是汇流点；裁掉就把下游剪没了）
    // 另一侧的 u 允许贴 0/1：干流在拐点处被支流蹭过时，交点正好落在段端点上；
    // 以前把这种也算“不算交叉” → 支流尖端越过干流一小段（量化后尤甚），画面上就是一个 X。
    if (!(t > 1e-6 && t < 1 - 1e-6 && u > -1e-6 && u < 1 + 1e-6)) return null;
    return { t, x: a.x + rx * t, y: a.y + ry * t };
  };

  const indexRiver = (r) => {
    const pts = r.points || [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) / cellSize), x1 = Math.floor(Math.max(a.x, b.x) / cellSize);
      const y0 = Math.floor(Math.min(a.y, b.y) / cellSize), y1 = Math.floor(Math.max(a.y, b.y) / cellSize);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = gx + ',' + gy;
          const arr = grid.get(k);
          if (arr) arr.push({ rid: r.id, a, b });
          else grid.set(k, [{ rid: r.id, a, b }]);
        }
      }
    }
  };

  const ordered = list.slice().sort((a, b) => ((b.discharge || 0) - (a.discharge || 0)) || ((a.id || 0) - (b.id || 0)));
  for (const r of ordered) {
    const pts = Array.isArray(r.points) ? r.points : [];
    if (pts.length < 2) continue;
    let hit = null;
    for (let i = 0; i + 1 < pts.length && !hit; i++) {
      const a = pts[i], b = pts[i + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) / cellSize), x1 = Math.floor(Math.max(a.x, b.x) / cellSize);
      const y0 = Math.floor(Math.min(a.y, b.y) / cellSize), y1 = Math.floor(Math.max(a.y, b.y) / cellSize);
      let best = null;
      const seen = new Set();
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const arr = grid.get(gx + ',' + gy);
          if (!arr) continue;
          for (const cand of arr) {
            if (cand.rid === r.id) continue;
            const key = cand.rid + ':' + cand.a.x + ':' + cand.a.y;
            if (seen.has(key)) continue;
            seen.add(key);
            const h = crossAt(a, b, cand.a, cand.b);
            if (!h) continue;
            if (!best || h.t < best.t) best = { ...h, rid: cand.rid };
          }
        }
      }
      if (best) hit = { ...best, seg: i };
    }
    if (hit) {
      const keep = pts.slice(0, hit.seg + 1);
      // 交点按调用方要求的精度量化（落库时是 0.01）——否则 a17 的“坐标 2 位小数”判据会红。
      // ⚠️ 量化前先沿本段**回退 0.1%**：直接量化会把断面又挪到干流另一侧一丝（实测 70 处
      //    “贴着汇流点的交叉”就是这么回来的）。回退量 ≈ 0.005 世界单位，12 倍下 0.03px。
      const rq = Number.isFinite(opts.round) && opts.round >= 0 ? Math.pow(10, Math.floor(opts.round)) : 0;
      const tCut = rq ? Math.max(0, hit.t - 3e-3) : hit.t;
      const aSeg = pts[hit.seg], bSeg = pts[hit.seg + 1];
      const cx = aSeg.x + (bSeg.x - aSeg.x) * tCut;
      const cy = aSeg.y + (bSeg.y - aSeg.y) * tCut;
      let px = rq ? Math.round(cx * rq) / rq : cx;
      let py = rq ? Math.round(cy * rq) / rq : cy;
      keep.push({ x: px, y: py, flux: pts[hit.seg].flux });
      const ratio = keep.length / pts.length;
      r.points = keep;
      if (Array.isArray(r.cells) && r.cells.length) {
        // 按**弧长**比例截 cells，不用点数比：meander 之后点数密度变了（每格 3~4 个点），
        // 点数比会把“截掉 40% 长”算成“截掉 80% 点”，cells 被削到 1 格（a3 判据当场红）。
        const lenOf = (arr) => {
          let L = 0;
          for (let i = 1; i < arr.length; i++) L += Math.hypot(arr[i].x - arr[i - 1].x, arr[i].y - arr[i - 1].y);
          return L;
        };
        const fullLen = lenOf(pts) || 1;
        const ratioLen = Math.max(0, Math.min(1, lenOf(keep) / fullLen));
        // ⚠️ `cells` 只服务**命名/分级/河口**（几何真值在 `points`）。按弧长截到 0 格会让
        //    “一格就并入大河的细沟”变成 1 格短棍（a3 判据：不许长短棍）——至少留 MIN_RIVER_CELLS 格；
        //    这是元数据下限，不是几何长度。
        const want = Math.round(r.cells.length * ratioLen);
        r.cells = r.cells.slice(0, Math.max(Math.min(r.cells.length, MIN_RIVER_CELLS), want));
        r.mouth = r.cells[r.cells.length - 1];
      }
      r.endInSea = false;
      r.endInLake = false;
      r.endAtEdge = false;
      r.lakeId = -1;
      // 截断后的端点**落在干流线上** = 一次合法汇流；打上标记，孤段判据（a5）认它。
      r.endsAtJunction = true;
      if (!r.parent && !wouldCycle(r.id, hit.rid)) { r.parent = hit.rid; joined++; }
      cut++;
    }
    indexRiver(r);
  }

  // ── 汇流点收口（2026-11-04 第二十一修，暮雨：12 倍下汇流点读成 X）──────────────────
  // 拓扑已经干净（真横穿 0），但**画法**上有两种“戳进主干”的尾巴：
  //   ① 被焊接截断的（上面主循环，`endsAtJunction` 已置 true）；
  //   ② 尾巴本来就贴在主干顶点上、没有真交叉的（主循环不会碰它 —— 实测 river_gen_436 就是这一类，
  //      它和 river_gen_216 落在同一个主干上的同一点，于是四臂星）。
  // 这一遍把两类一起处理：按 discharge 从大到小认领落点，后到的若与已认领的落点 < declumpGap，
  // 就沿主干**向下游**挪到下一个顶点（顶点在线上，量化不会挪偏；挪完还验一次不横穿别的河）。
  const nearestOther = (x, y, selfId, reach) => {
    const gx0 = Math.floor((x - reach) / cellSize), gx1 = Math.floor((x + reach) / cellSize);
    const gy0 = Math.floor((y - reach) / cellSize), gy1 = Math.floor((y + reach) / cellSize);
    let best = null;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const arr = grid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const cand of arr) {
          if (cand.rid === selfId) continue;
          const dx = cand.b.x - cand.a.x, dy = cand.b.y - cand.a.y;
          const L2 = dx * dx + dy * dy;
          if (!L2) continue;
          const u = Math.max(0, Math.min(1, ((x - cand.a.x) * dx + (y - cand.a.y) * dy) / L2));
          const d = Math.hypot(x - (cand.a.x + dx * u), y - (cand.a.y + dy * u));
          if (d <= reach && (!best || d < best.d)) best = { d, rid: cand.rid };
        }
      }
    }
    return best;
  };
  /** 在 reach 内找“该把尾巴挂到谁家”：距离最近的几条里**汇流量最大**的那条。
   *  为什么不直接取最近的：两条尾巴落在同一点时彼此距离是 0，会互相把对方认成主干
   *  （实测 26 对同点汇入只拆掉 14 对就是这个原因）。取“最近的那一档里最大的”，
   *  既不会跳到远处的河上，又能稳定指到真正的主干。 */
  const hostAt = (x, y, selfId, reach) => {
    const gx0 = Math.floor((x - reach) / cellSize), gx1 = Math.floor((x + reach) / cellSize);
    const gy0 = Math.floor((y - reach) / cellSize), gy1 = Math.floor((y + reach) / cellSize);
    const cands = [];
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const arr = grid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const cand of arr) {
          if (cand.rid === selfId) continue;
          const dx = cand.b.x - cand.a.x, dy = cand.b.y - cand.a.y;
          const L2 = dx * dx + dy * dy;
          if (!L2) continue;
          const u = Math.max(0, Math.min(1, ((x - cand.a.x) * dx + (y - cand.a.y) * dy) / L2));
          const d = Math.hypot(x - (cand.a.x + dx * u), y - (cand.a.y + dy * u));
          if (d <= reach) cands.push({ rid: cand.rid, d });
        }
      }
    }
    if (!cands.length) return null;
    let d0 = Infinity;
    for (const c of cands) if (c.d < d0) d0 = c.d;
    let best = null;
    for (const c of cands) {
      if (c.d > d0 + 0.15) continue;                  // 只和“最贴的那一档”比
      const q = Number(byId.get(c.rid) && byId.get(c.rid).discharge) || 0;
      const qb = best ? (Number(byId.get(best.rid) && byId.get(best.rid).discharge) || 0) : -1;
      if (!best || q > qb || (q === qb && c.d < best.d)) best = c;
    }
    return best;
  };
  // 0.6 而不是 0.35：`snapRiverTails` 只把尾巴接到 99.5% 处（留 0.005·gap 的余量防量化越线），
  // 实测留下来的“同点汇入”里有 0.4~0.5 的尾巴 —— 容差给 0.4 会让它们整对落在门外观望。
  const attachTol = Math.max(0.5, cellSize * 0.075);
  // 先给每条尾巴找一次宿主（见 hostAt 的说明），再认领落点
  const hostOf = new Map();
  for (const r of list) {
    const pts = Array.isArray(r.points) ? r.points : [];
    if (pts.length < 2 || r.endInSea || r.endInLake) continue;
    const tail = pts[pts.length - 1];
    const n = hostAt(tail.x, tail.y, r.id, attachTol);
    if (n) hostOf.set(r.id, n.rid);
  }
  const log = [];                             // 排障：每条尾巴的去向（moved / first / cross / no-vertex）
  const accepted = new Map();                 // 主干 id → 已经认领的汇流点
  const origTail = new Map();                 // 河 id → 挪之前的尾巴（第二遍不合格就退回去）
  for (const r of ordered) {
    const pts = Array.isArray(r.points) ? r.points : [];
    if (pts.length < 2 || r.endInSea || r.endInLake) continue;
    const tail = pts[pts.length - 1];
    const hostRid = (r.endsAtJunction && r.parent) ? r.parent : (hostOf.get(r.id) || 0);
    if (!hostRid) continue;
    const host = { rid: hostRid };
    // ② 类尾巴：贴上了也算汇流（渲染侧要靠这个标记收窄河口，否则就是一根戳进去的断头）
    if (!r.endsAtJunction) r.endsAtJunction = true;
    const used = accepted.get(host.rid) || [];
    if (used.some((p) => Math.hypot(p.x - tail.x, p.y - tail.y) < declumpGap)) {
      const hostPts = (byId.get(host.rid) || {}).points;
      let v = advanceToVertex(hostPts, tail.x, tail.y, declumpGap, 1);
      let ok = !!v && !crossesIndexed(tail, v, r.id);
      if (!ok) {
        const back = advanceToVertex(hostPts, tail.x, tail.y, declumpGap, -1);
        if (back && !crossesIndexed(tail, back, r.id)) { v = back; ok = true; }
      }
      if (v) {
        origTail.set(r.id, { x: tail.x, y: tail.y });
        // ⚠️ 就地改（不要换成新对象）：网格里存的段引用指向**这个点对象**，
        //    换对象会让后面的复验看到旧几何（假阴性/假阳性都会出现）。
        tail.x = v.x; tail.y = v.y;
        declumped++;
        log.push({ id: r.id, host: host.rid, act: 'moved' });
      } else {
        log.push({ id: r.id, host: host.rid, act: 'no-room' });
      }
    } else {
      log.push({ id: r.id, host: host.rid, act: 'first' });
    }
    const fin = pts[pts.length - 1];
    used.push({ x: fin.x, y: fin.y });
    accepted.set(host.rid, used);
  }
  // 第二遍：**挪过的**尾巴再验一次（后挪的可能与先挪的凑出一个新交叉，第一遍时还看不见）。
  // 不合格就退回原位 —— 宁可留一个四臂星，也不许为了观感制造真交叉。
  for (const [rid, orig] of origTail) {
    const r = byId.get(rid);
    const pts = (r && Array.isArray(r.points)) ? r.points : null;
    if (!pts || pts.length < 2) continue;
    const tail = pts[pts.length - 1];
    if (crossesIndexed(pts[pts.length - 2], tail, r.id)) {
      tail.x = orig.x; tail.y = orig.y;      // 同样就地改（网格里的段引用指着这个对象）
      declumped--;
    }
  }
  return { cut, joined, declumped, log: opts.debug ? log.slice(0, 400) : [] };
}
