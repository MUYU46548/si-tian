// utils/provinceOverlap.js
// 新建省份的「压叠闸门」纯函数层（无 DOM、无 Vue、无 store）
//
// 为什么需要它：
//   ① 省份是**互相独立的多边形**，没有任何排他约束 —— 画一个压住邻居的新省完全合法，
//      而画布渲染是「按 terrain 数组序依次 fill」→ 数组靠后的盖在上面。于是「看得见的那块」
//      未必是「点得到的那块」（命中口径另有一处修复：`findProvinceAt` 改为自顶向下）。
//   ② 压叠还会污染一切按面积算的东西：`ownership` 归属显示、势力标签的面积加权质心、
//      谱系继承的重叠度 —— 两个省压在一起时，观感是「名字跑到别人地界里」。
//   ③ 但**不能硬拒**：用户确实会想「照着一张更大的范围重画」或「先画再修」。所以本模块只做
//      **度量**（返回比例与占用者），由调用方决定拦还是问；阈值也作为参数传入（用例可注入）。
//
// 度量口径（明说，不装作精确）：
//   · 在**候选省**的包围盒上铺一张 ≤ `OVERLAP_MAX_DIM²` 的采样格，取格心；
//   · `total` = 格心落在候选省内的格数；`occupied` = 其中同时落在**别的省**内的格数；
//   · `ratio = occupied / total` —— 即「这个新省有多大比例压在别人身上」。
//   · 大省（顶点数 > `MAX_POINTS_PER_PROVINCE`）按步长抽稀后再判，结果带 `approx: true`
//     ——**不抽稀的话**：真实库有两个 1 万点的省，格心数 × 顶点数会到千万级，卡在抬手那一帧。
//     抽稀只用于**度量**，绝不写回任何几何。
import { pointInProvince, provinceBBox } from './provinceShape';

/** 新省与已有省的重叠比例超过这个值 → 判为「压叠」（调用方通常据此二次确认） */
export const OVERLAP_REJECT_RATIO = 0.25;
/** 采样格上限（每边）。40×40 = 1600 个格心，够判断 25% 量级，又不至于卡帧 */
export const OVERLAP_MAX_DIM = 40;
/** 单个已有省参与判定时的顶点上限（超过则按步长抽稀，结果标 approx） */
export const MAX_POINTS_PER_PROVINCE = 600;

/** 从 `[{x,y}]` / 省份对象 两种形态取候选几何 */
function asCandidate(candidate) {
  if (!candidate) return null;
  if (Array.isArray(candidate)) {
    return candidate.length >= 3 ? { points: candidate } : null;
  }
  const pts = candidate.points || candidate.d || [];
  if (!Array.isArray(pts) || pts.length < 3) return null;
  return candidate;
}

/** 按步长抽稀点列（保留首尾，均匀取点）——只用于度量 */
function subsample(points, max) {
  const n = points.length;
  if (n <= max) return points;
  const step = n / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  return out;
}

/** 省份对象 → 抽稀后的「同形状」代理（保留 extraRings，洞/飞地语义不丢） */
function approxShape(prov) {
  const main = subsample(prov.points || prov.d || [], MAX_POINTS_PER_PROVINCE);
  const extraRings = (prov.extraRings || []).map((r) => {
    const pts = Array.isArray(r) ? r : (r && r.points);
    if (!Array.isArray(pts) || pts.length < 3) return null;
    return {
      points: subsample(pts, MAX_POINTS_PER_PROVINCE),
      kind: (r && r.kind) || prov.kind,
      fromGrid: !!(r && r.fromGrid),
    };
  }).filter(Boolean);
  return { points: main, extraRings, kind: prov.kind };
}

/** 顶点是否被抽稀过（决定 `approx`） */
function isSampled(prov) {
  if ((prov.points || prov.d || []).length > MAX_POINTS_PER_PROVINCE) return true;
  return (prov.extraRings || []).some((r) => {
    const pts = Array.isArray(r) ? r : (r && r.points);
    return Array.isArray(pts) && pts.length > MAX_POINTS_PER_PROVINCE;
  });
}

/**
 * 度量候选省与已有省的重叠。
 *
 * @param {object|Array} candidate 候选省（省份对象或纯点数组）
 * @param {Array} existing 已有省份表（`terrain[]`）
 * @param {object} [opts]
 * @param {number} [opts.ratio=OVERLAP_REJECT_RATIO] 判定阈值（仅用于 `blocked` 与 `offenders` 过滤）
 * @param {number} [opts.maxDim=OVERLAP_MAX_DIM] 采样格上限
 * @param {string} [opts.skipId] 需要排除的省份 id（例如编辑自身时）
 * @returns {{ok:boolean, ratio:number, blocked:boolean, total:number, occupied:number,
 *            cell:number, dim:number, approx:boolean, offenders:Array, threshold:number}}
 */
export function measureProvinceOverlap(candidate, existing, opts = {}) {
  const threshold = Number.isFinite(opts.ratio) ? opts.ratio : OVERLAP_REJECT_RATIO;
  const maxDim = Math.max(4, Math.round(opts.maxDim || OVERLAP_MAX_DIM));
  const empty = {
    ok: true, ratio: 0, blocked: false, total: 0, occupied: 0,
    cell: 0, dim: 0, approx: false, offenders: [], threshold,
  };
  const cand = asCandidate(candidate);
  if (!cand) return empty;
  const candBox = provinceBBox(cand);
  if (!candBox) return empty;

  // 只留与候选包围盒相交的已有省（大多数省的包围盒离得很远 → 这一步省掉绝大部分顶点）
  // ⚠️ 抽稀必须作用在**省份对象**上（`pointInProvince` 要 `points` + `extraRings` 才能算洞/飞地），
  //    传点数组进去会退化成「不在任何省内」= 恒不重叠的假绿。
  const list = [];
  const seen = new Set();
  for (const p of (existing || [])) {
    if (!p || !p.id) continue;
    if (opts.skipId && p.id === opts.skipId) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const b = provinceBBox(p);
    if (!b) continue;
    if (b.maxX < candBox.minX || b.minX > candBox.maxX) continue;
    if (b.maxY < candBox.minY || b.minY > candBox.maxY) continue;
    const shape = approxShape(p);
    if (!shape.points || shape.points.length < 3) continue;
    list.push({
      id: p.id,
      name: p.name || p.id,
      kind: p.kind === 'sea' ? 'sea' : 'land',
      box: b,
      shape,
      sampled: isSampled(p),
    });
  }
  // ⚠️ 这里**不早退**：`total`（候选自己的采样格数）是给调用方看的分母，附近一个省都没有时
  //    它也该是真实值而不是 0（否则"占用 0 / 共 0 格"这种自相矛盾的结果会误导排查）。
  const span = Math.max(candBox.maxX - candBox.minX, candBox.maxY - candBox.minY);
  if (!(span > 0)) return empty;
  const dim = maxDim;
  const cell = span / dim;
  const candShape = approxShape(cand);
  const approx = list.some((p) => p.sampled) || isSampled(cand);

  let total = 0;
  let occupied = 0;
  const hits = new Map();
  for (let r = 0; r < dim; r++) {
    const y = candBox.minY + (r + 0.5) * cell;
    if (y > candBox.maxY) break;
    for (let c = 0; c < dim; c++) {
      const x = candBox.minX + (c + 0.5) * cell;
      if (x > candBox.maxX) break;
      if (!pointInProvince(x, y, candShape)) continue;
      total++;
      for (const p of list) {
        if (x < p.box.minX || x > p.box.maxX || y < p.box.minY || y > p.box.maxY) continue;
        if (!pointInProvince(x, y, p.shape)) continue;
        occupied++;
        hits.set(p.id, (hits.get(p.id) || 0) + 1);
        break;                                  // 一格只记一次（谁先命中不影响比例）
      }
    }
  }

  const ratio = total > 0 ? occupied / total : 0;
  const offenders = [...hits.entries()]
    .map(([id, cells]) => {
      const p = list.find((q) => q.id === id);
      return { id, name: p ? p.name : id, kind: p ? p.kind : 'land', cells, ratio: total ? cells / total : 0 };
    })
    .sort((a, b) => b.cells - a.cells);
  return {
    ok: true, ratio, blocked: ratio > threshold, total, occupied,
    cell, dim, approx, offenders, threshold,
  };
}

/** 给用户看的一句话（点名占用者 + 百分比 + 建议去处） */
export function describeOverlap(res, { maxNames = 2 } = {}) {
  if (!res || !res.blocked) return '';
  const pct = Math.round(res.ratio * 100);
  const names = (res.offenders || []).slice(0, maxNames)
    .map((o) => `${o.name}${o.kind === 'sea' ? '（海域）' : ''} ${Math.round(o.ratio * 100)}%`);
  return `这个新省有 ${pct}% 压在已有省份上${names.length ? `：${names.join('、')}` : ''}`
    + '——压叠会让点选、归属上色和势力标签互相打架。'
    + '建议先删除/改轮廓，或换一块空地；确实要覆盖就先确认再创建。';
}
