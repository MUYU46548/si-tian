// utils/freehandRing.js — 自由绘制的**闭环净化**（2026-10-22，三刀序列·第三刀）
//
// 为什么要它：用户手画的圈几乎不可能「一笔正好闭合且不自交」。实测（Node 复刻同一条链）：
//   · 画一个 8 字（两圈交叉）：简化后 18 个点、**自交 1 处**、fill(面积/包围盒) = 0.002 ——
//     落库后就是一个「几乎没面积、带一个洞的怪多边形」，画布上只看到几条线；
//   · 画方框时松手前手一抖往回勾一下（非常常见）：自交 1 处、出现 175° 的尖刺。
// 以前这两笔都会**原样落库**，用户看到的就是「只画诡异几何」。
//
// 现在：落库前过这一层 —— 在自交点处把环切成两段，**保留面积大的那一段**（8 字 → 一个瓣；
// 回勾 → 方框本体），再判「面积太小 / 细成一条线」就明确拒绝（附人话原因），不造怪形状。
//
// 为什么不用 polygon-clipping 归一：它的 union 对自交环按 nonzero 缠绕算，8 字两瓣方向相反时
// 会把一瓣当**洞**，结果只剩两瓣交叠的一小块（实测真机：100×20 的 8 字被归一成 10×8 的碎块，
// 还被判成压在别的省上）。而且它在极端自交输入上可能长时间不返回（拖笔时卡住主线程）。
// 切环是纯算术、O(n²)、可预测，也不引第三方依赖。
//
// ⚠️ 纯函数：不改入参、不碰 store/DOM。
'use strict';

/** 自交检测（O(n²)，环点数在几十量级，不需要空间索引） */
export function selfIntersectionCount(points) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n < 4) return 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((j + 1) % n === i || (i + 1) % n === j) continue;   // 相邻边不算
      if (properCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) count += 1;
    }
  }
  return count;
}

/** 有符号面积（环方向；绝对值才是面积） */
export function ringSignedArea(points) {
  const pts = points || [];
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]; const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function ringAreaAbs(points) {
  return Math.abs(ringSignedArea(points));
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function properCross(a, b, c, d) {
  const d1 = cross(c, d, a); const d2 = cross(c, d, b);
  const d3 = cross(a, b, c); const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 两条线段的交点（调用前保证 properCross 为真） */
function segmentIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

function bboxOf(points) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 相邻重复点 / 首尾重合清理（与 regionTrace.closedRing 同口径，避免两处实现漂移） */
function cleanRing(points) {
  const src = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const out = [];
  for (const p of src) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) continue;
    out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1) {
    const first = out[0]; const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) out.pop();
    else break;
  }
  return out;
}

/**
 * 在自交点处把环切成两段，保留面积大的那段；重复直到没有自交（或判定太乱）。
 * @returns {{points:Array, cuts:number, droppedArea:number, failed:boolean}}
 */
function largestSimpleLoop(points, maxCuts = 12) {
  let ring = points.slice();
  let cuts = 0;
  let droppedArea = 0;
  for (let guard = 0; guard <= maxCuts; guard++) {
    const n = ring.length;
    if (n < 3) return { points: ring, cuts, droppedArea, failed: true };
    let hit = null;
    for (let i = 0; i < n && !hit; i++) {
      for (let j = i + 1; j < n; j++) {
        if ((j + 1) % n === i || (i + 1) % n === j) continue;
        if (properCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) {
          hit = { i, j, at: segmentIntersection(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]) };
          break;
        }
      }
    }
    if (!hit) return { points: ring, cuts, droppedArea, failed: false };
    // A = i..j（含交点），B = j..n-1 + 0..i（含交点）
    const A = ring.slice(hit.i + 1, hit.j + 1).concat([{ x: hit.at.x, y: hit.at.y }]);
    const B = ring.slice(hit.j + 1).concat(ring.slice(0, hit.i + 1), [{ x: hit.at.x, y: hit.at.y }]);
    const usable = [A, B].filter((r) => r.length >= 3);
    if (!usable.length) return { points: ring, cuts, droppedArea, failed: true };
    usable.sort((a, b) => ringAreaAbs(b) - ringAreaAbs(a));
    const drop = usable[1];
    if (drop) droppedArea += ringAreaAbs(drop);
    ring = cleanRing(usable[0]);
    cuts += 1;
  }
  return { points: ring, cuts, droppedArea, failed: selfIntersectionCount(ring) > 0 };
}

/**
 * 把一笔手画闭环净化为「一块正常的面」。
 *
 * @param {Array<{x:number,y:number}>} points 简化后的环
 * @param {{minArea?:number, minFill?:number}} opts
 *        `minArea` 绝对面积下限（世界单位²）——挡掉「点一下 / 一条线」；
 *        `minFill` 面积 / 包围盒 下限（默认 0.02）——挡掉「几乎没面积的细条」
 * @returns {{ok:boolean, points:Array, area:number, fill:number, selfInt:number,
 *            selfIntBefore:number, dropped:number, droppedArea:number, holes:number, reason?:string}}
 */
export function sanitizeFreehandRing(points, opts = {}) {
  const minArea = Number.isFinite(opts.minArea) ? opts.minArea : 1;
  const minFill = Number.isFinite(opts.minFill) ? opts.minFill : 0.02;
  const ring = cleanRing(points);
  const empty = {
    ok: false, points: ring, area: 0, fill: 0, selfInt: 0, selfIntBefore: 0,
    dropped: 0, droppedArea: 0, holes: 0,
  };
  if (ring.length < 3) return { ...empty, reason: 'too-few-points' };

  const selfIntBefore = selfIntersectionCount(ring);
  let outer = ring;
  let dropped = 0;
  let droppedArea = 0;

  if (selfIntBefore > 0) {
    const res = largestSimpleLoop(ring);
    if (res.failed || res.points.length < 3) {
      return { ...empty, selfIntBefore, selfInt: selfIntBefore, reason: 'too-messy' };
    }
    outer = res.points;
    dropped = res.cuts;
    droppedArea = res.droppedArea;
  }

  const selfInt = selfIntersectionCount(outer);
  if (selfInt > 0) {
    return { ...empty, points: outer, selfIntBefore, selfInt, dropped, droppedArea, reason: 'too-messy' };
  }

  const area = ringAreaAbs(outer);
  const box = bboxOf(outer);
  const fill = area / Math.max(1e-9, box.w * box.h);
  const base = {
    points: outer, area, fill, selfInt, selfIntBefore, dropped, droppedArea, holes: 0,
  };
  if (!(area > minArea)) return { ...base, ok: false, reason: 'degenerate' };
  if (!(fill >= minFill)) return { ...base, ok: false, reason: 'too-thin' };
  return { ...base, ok: true };
}

/** 拒绝原因 → 给用户看的一句话（唯一出处，组件/用例都从这里取） */
export function explainFreehandRejection(result) {
  const reason = (result && result.reason) || '';
  if (reason === 'too-few-points') return '轨迹太短（还没围出一块地）';
  if (reason === 'degenerate') return '这一笔没围出面积（画成了一条线？请画一个闭合的圈）';
  if (reason === 'too-thin') return '这一笔太细 / 打结了（请画一个围得起来的圈，别来回抹）';
  if (reason === 'too-messy') return '这一笔交叉太多（自己绕成一团了），请重画一个圈';
  return '';
}

export default { sanitizeFreehandRing, selfIntersectionCount, ringSignedArea, explainFreehandRejection };
