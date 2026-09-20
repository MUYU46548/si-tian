// utils/regionTrace.js — 区域「勾轮廓」管线：闭环保形简化 + 离屏光栅校验（Phase 2.6）
//
// 用户勾完一条自由轮廓后，落库前统一走三步：
//   ① 闭环保形简化（RDP，去掉手抖毛刺；保证顶点数可控、轮廓不抖）
//   ② 离屏 canvas 光栅化，算两个面积占比：
//        · 落地内  insideRatio  = 轮廓 ∩ 可绘制范围 / 轮廓
//        · 不重叠  overlapRatio = 轮廓 ∩ 单个已有区域 / 轮廓
//   ③ 通过才落库（走 store 的 undo），不通过就把原因写到状态栏并取消本次绘制
//
// 为什么用离屏 canvas 光栅化而不是手写多边形布尔运算：
//   手写裁剪（Sutherland-Hodgman）**只对凸裁剪窗口成立** —— 地图上的凹轮廓会被静默裁空
//   （不报错、返回空数组）。Canvas 的 fill 天然支持任意凹多边形与自交路径；
//   我们只需要「面积占比」这类统计量，一次光栅化算完。见 skill 铁律 §111 / §112。
//
// ⚠️ 本模块**不改数据**：只做「算 + 判」，落库由调用方（PlanetMap / AreaMap）负责。
//    唯一的 DOM 依赖是离屏 canvas，所以不能进 Node 单元测试（走 CDP 用例）。

import { polygonArea } from './geometry';
import { simplifyPath } from './geometry';

export const TRACE_LIMITS = {
  simplifyEps: 2,        // 简化容差（世界单位）
  maxRasterDim: 512,     // 光栅化单边最大像素（控成本：512² = 26 万格）
  minInsideRatio: 0.5,   // 低于此比例视为「基本画在可绘制范围之外」→ 拒绝
  warnInsideRatio: 0.98, // 低于此比例但通过 → 仅提示（不算失败）
  maxOverlapRatio: 0.05, // 与单个已有区域重叠超过此比例 → 拒绝（与地形重叠阈值一致）
  minArea: 1,            // 面积下限（世界单位²）：挡掉「点一下」产生的退化多边形
};

/** 取环的点数组：接受 `[{x,y}]` 或 `{ points:[…] }`（区域/地形条目）两种形态 */
function ringOf(ring) {
  if (!ring) return [];
  return Array.isArray(ring) ? ring : (ring.points || []);
}

function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

function bboxesOverlap(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/**
 * 闭合环清理：去掉相邻重复点 + 收尾重合点。
 * 自由绘制的轨迹首尾必然几乎重合（松手点靠近起点），不清理会让 RDP 的
 * 首尾基线退化成零长度线段（简化质量崩掉，还会多留一个重复顶点）。
 */
export function closedRing(points) {
  const src = (points || []).filter(p => p && isFinite(p.x) && isFinite(p.y));
  const out = [];
  for (const p of src) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) continue;
    out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1) {
    const first = out[0], last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) out.pop();
    else break;
  }
  return out;
}

/**
 * 闭合轮廓的保形简化（RDP）。
 *
 * 为什么不能直接用 geometry.simplifyPath：那是**开曲线**算法，以首尾点为基线；
 * 闭合环的首尾是同一点 → 基线长度 0 → 简化结果退化。做法是先旋转到
 * 「离质心最远的点」当锚点（该点几乎必然被保留），把环拆成开链再简化。
 * 锚点选最远点而不是固定下标，是为了让结果与「从哪一格起笔」无关（可复现）。
 */
export function simplifyClosedTrace(points, eps = TRACE_LIMITS.simplifyEps) {
  const ring = closedRing(points);
  if (ring.length <= 3) return ring;

  const bbox = bboxOf(ring);
  const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  // 容差必须跟着形状尺寸走，不能是固定世界单位：
  //   · 行星图的世界单位是「米」量级（边界 ±1500），适配视图后 1 像素 ≈ 3~5 世界单位，
  //     手抖的幅度本身就是几个像素 → 固定 eps=2 什么都削不掉（实测 200 点只降到 111 点）；
  //   · 取 span 的 2%（手抖下限）到 5%（上限）：小轮廓不至于被压成三角形，大轮廓也不会被削掉细节。
  const useEps = Math.max(Math.min(eps, span / 20), Math.min(span * 0.02, span / 20));

  let cx = 0, cy = 0;
  for (const p of ring) { cx += p.x; cy += p.y; }
  cx /= ring.length; cy /= ring.length;
  let anchor = 0, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i].x - cx) ** 2 + (ring[i].y - cy) ** 2;
    if (d > best) { best = d; anchor = i; }
  }
  const rot = ring.slice(anchor).concat(ring.slice(0, anchor));
  const open = rot.concat([{ x: rot[0].x, y: rot[0].y }]);
  const simplified = simplifyPath(open, useEps);
  simplified.pop();                       // 去掉为闭环补的那一个重复收尾点
  return simplified.length >= 3 ? simplified : ring;
}

/**
 * 离屏光栅化统计：把环填成掩膜，逐像素算交集。
 * @returns {{ pixels:number, insideRatio:number, overlapRatio:number,
 *            overlaps:Array<{name:string, ratio:number}>, rasterSize:{w:number,h:number} }}
 */
export function traceStats({ trace, containers = [], siblings = [], limits = {} }) {
  const L = { ...TRACE_LIMITS, ...limits };
  const ring = closedRing(trace);
  const empty = { pixels: 0, insideRatio: 1, overlapRatio: 0, overlaps: [], rasterSize: null };
  if (ring.length < 3) return empty;

  const bbox = bboxOf(ring);
  const w = Math.max(bbox.maxX - bbox.minX, 1e-6);
  const h = Math.max(bbox.maxY - bbox.minY, 1e-6);
  const cell = Math.max(w, h) / L.maxRasterDim;
  const W = Math.max(2, Math.ceil(w / cell) + 1);
  const H = Math.max(2, Math.ceil(h / cell) + 1);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return empty;

  const toPx = (p) => ({ x: (p.x - bbox.minX) / cell, y: (bbox.maxY - p.y) / cell });

  /** 把若干环并集填成一个 0/1 掩膜（nonzero 填充 → 重叠部分仍是 1，天然取并集） */
  function maskOf(rings) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    for (const r of rings) {
      const pts = closedRing(r);
      if (pts.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const q = toPx(pts[i]);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.fill();
    }
    const data = ctx.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0;
    return out;
  }

  const traceMask = maskOf([ring]);
  let pixels = 0;
  for (let i = 0; i < traceMask.length; i++) pixels += traceMask[i];
  if (pixels === 0) return { ...empty, rasterSize: { w: W, h: H } };

  const contRings = containers.map(ringOf).filter(r => r.length >= 3);
  let insideRatio = 1;
  if (contRings.length) {
    const contMask = maskOf(contRings);
    let hit = 0;
    for (let i = 0; i < traceMask.length; i++) if (traceMask[i] && contMask[i]) hit++;
    insideRatio = hit / pixels;
  }

  // 只跟「包围盒与本次轮廓相交」的兄弟区域比 —— 数量与成本都可控
  const overlaps = [];
  for (const s of siblings) {
    const sRing = ringOf(s);
    if (sRing.length < 3) continue;
    const sBox = bboxOf(sRing);
    if (!sBox || !bboxesOverlap(sBox, bbox)) continue;
    const sMask = maskOf([sRing]);
    let hit = 0;
    for (let i = 0; i < traceMask.length; i++) if (traceMask[i] && sMask[i]) hit++;
    if (hit > 0) overlaps.push({ name: (s && s.name) || '未命名区域', ratio: hit / pixels });
  }
  overlaps.sort((a, b) => b.ratio - a.ratio);

  return {
    pixels,
    insideRatio,
    overlapRatio: overlaps.length ? overlaps[0].ratio : 0,
    overlaps,
    rasterSize: { w: W, h: H },
  };
}

const pct = (r) => `${Math.round(r * 100)}%`;

/**
 * 勾轮廓落库前的统一校验（纯判定，不写数据）。
 *
 * @param {object}   o
 * @param {Array}    o.points      用户勾出的原始轮廓（世界坐标）
 * @param {Array}    o.containers  「可绘制范围」多边形（数组套数组）。空数组 = 不定范围 → 跳过落地内检查
 * @param {Array}    o.siblings    已有区域（`{id,name,points}` 或裸点数组）
 * @param {boolean}  o.simplify    是否做闭环保形简化（自由绘制 true；点描顶点 false，那是刻意摆的）
 * @param {number}   o.eps         简化容差
 * @param {number}   o.selfIndex   自身在 siblings 里的下标（重绘已有区域时排除自己）
 * @param {object}   o.limits      覆盖 TRACE_LIMITS
 * @returns {{ ok:boolean, code:string, message:string, points:Array,
 *             warnings:string[], stats:object }}
 *          code: ok | too-few-points | degenerate | overlap | outside
 */
export function validateRegionTrace({
  points, containers = [], siblings = [], simplify = true,
  eps = TRACE_LIMITS.simplifyEps, selfIndex = -1, limits = {},
} = {}) {
  const L = { ...TRACE_LIMITS, ...limits };
  const cleaned = simplify ? simplifyClosedTrace(points, eps) : closedRing(points);

  if (cleaned.length < 3) {
    return {
      ok: false, code: 'too-few-points', points: cleaned, stats: null, warnings: [],
      message: `区域至少需要 3 个顶点（当前 ${cleaned.length} 个），已取消`,
    };
  }
  const area = Math.abs(polygonArea(cleaned));
  if (!(area > L.minArea)) {
    return {
      ok: false, code: 'degenerate', points: cleaned, stats: null, warnings: [],
      message: `区域面积过小（${area.toFixed(1)}），已取消`,
    };
  }

  const others = siblings.filter((_, i) => i !== selfIndex);
  const stats = traceStats({ trace: cleaned, containers, siblings: others, limits: L });

  // 先判重叠：覆盖别人的区域是最难事后发现的（两团半透明色叠在一起看着只是"颜色深了点"）
  if (others.length && stats.overlapRatio > L.maxOverlapRatio) {
    const top = stats.overlaps[0];
    const extra = stats.overlaps.length > 1 ? ` 等 ${stats.overlaps.length} 个已有区域` : '';
    return {
      ok: false, code: 'overlap', points: cleaned, stats, warnings: [],
      message: `区域与「${top.name}」${extra}重叠 ${pct(top.ratio)}，已取消（区域之间不应互相覆盖）`,
    };
  }
  if (containers.length && stats.insideRatio < L.minInsideRatio) {
    return {
      ok: false, code: 'outside', points: cleaned, stats, warnings: [],
      message: `区域仅 ${pct(stats.insideRatio)} 落在可绘制范围内，已取消（请画在地图范围内）`,
    };
  }

  const warnings = [];
  if (containers.length && stats.insideRatio < L.warnInsideRatio) {
    warnings.push(`区域已创建，但有 ${pct(1 - stats.insideRatio)} 落在可绘制范围之外`);
  }
  return {
    ok: true, code: 'ok', points: cleaned, stats, warnings,
    message: `已创建区域（${cleaned.length} 个顶点）`,
  };
}
