/**
 * utils/vertexSharing.js — 「共边顶点」的配对与联动移动（P1，2026-10-13）
 *
 * ## 为什么需要这一层
 *
 * 司天里**省份是各自独立的多边形**，"共边"只是两端坐标**恰好相同**：
 *   · 网格派生的省份（`ringsFromLabels`）共用同一批格边 → 坐标逐位相同；
 *   · FMG `.map` 导入的相邻州来自同一段 SVG 路径 → 同样重合；
 *   · 手绘/描点走 `conformToSkeleton` 吸附骨架 → 重合顶点由骨架保证。
 * 于是"拖动 A 的一个共边顶点"时，B 那边**留在原地** → 地图上出现缝（或反过来压叠）。
 *
 * ## 方案甲（暮雨 2026-10-13 定）
 *
 * 在"共边顶点坐标相同"这个前提下，**让邻省的同位顶点跟着一起平移**就是他要的效果：
 * 边界线整体移动 —— A 缩多少 B 就涨多少，**无缝、无压叠**，而且**不碰任何别的省**。
 * 关键好处是**不需要任何布尔运算**：几十万点的底图上，一次拖动只是改几个坐标，
 * 不存在「先并后挖」跨边界压叠那一类问题（本仓在布尔路径上踩过的坑都在 AGENTS 里）。
 *
 * 三条纪律：
 *   ① **只认坐标，不认"谁是邻居"**：配对判据是「坐标落在同一个量化格里」，
 *      不做拓扑推断（拓扑推断要有洞/飞地的正确归属，代价高且容易静默出错）。
 *   ② **差量平移**：邻省同位顶点按"与参考顶点的偏差"一起移动，而不是直接写同一个坐标 ——
 *      两侧本来就相差 1e-9 级的浮点误差时，各自动各自的分量，重合关系不会被磨掉。
 *   ③ **不做静默兜底**：配不到同位顶点的（海岸线、与邻省顶点数不匹配的段）**就是不动**，
 *      由调用方如实告诉用户"这次只改了一个省的形状"，而不是偷偷做布尔补洞。
 *
 * 纯函数、无 DOM、无 store 依赖 → 可直接 Node 单测（`scripts/tests/unit/test_vertex_sharing.js`）。
 */

import { provinceRings } from './provinceShape';

/** 顶点坐标的量化格边长（世界单位）。1e-3 远小于任何真实底图的顶点间距（米级），
 *  又足以吸收 JSON 往返的浮点尾差；`desite` 实测相邻省共边顶点是**逐位相同**的。 */
export const VERTEX_QUANTUM = 1e-3;

/** 一次联动最多带多少个同位顶点（防病态数据：某些生成器会在同一点堆几十个省角） */
export const MAX_LINKED_VERTICES = 24;

function px(p) {
  if (!p) return NaN;
  return Array.isArray(p) ? p[0] : p.x;
}

function py(p) {
  if (!p) return NaN;
  return Array.isArray(p) ? p[1] : p.y;
}

/** 量化键：把坐标压成一个整数格，共边顶点（含 1e-9 级尾差）落进同一格 */
export function vertexKey(x, y, quantum = VERTEX_QUANTUM) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return `${Math.round(x / quantum)}|${Math.round(y / quantum)}`;
}

/**
 * 全底图的「坐标 → 顶点」索引。
 * @param {Array} provinces `baseMap.terrain`
 * @returns {{ index: Map<string, Array<{provIdx:number, ringIdx:number, vertexIdx:number, x:number, y:number}>>, total: number, shared: number }}
 *   `shared` = 落在"不止一个顶点"的格里的顶点数（= 参与共边的顶点数，诊断用）
 */
export function buildCoincidentIndex(provinces, { quantum = VERTEX_QUANTUM } = {}) {
  const index = new Map();
  let total = 0;
  (provinces || []).forEach((prov, provIdx) => {
    const rings = provinceRings(prov);
    rings.forEach((ring, ringIdx) => {
      const pts = (ring && ring.points) || [];
      for (let vertexIdx = 0; vertexIdx < pts.length; vertexIdx++) {
        const x = px(pts[vertexIdx]);
        const y = py(pts[vertexIdx]);
        const key = vertexKey(x, y, quantum);
        if (!key) continue;
        let arr = index.get(key);
        if (!arr) { arr = []; index.set(key, arr); }
        arr.push({ provIdx, ringIdx, vertexIdx, x, y });
        total++;
      }
    });
  });
  let shared = 0;
  for (const arr of index.values()) if (arr.length > 1) shared += arr.length;
  return { index, total, shared };
}

/**
 * 找出「这些顶点在别的省份里的同位顶点」。
 *
 * @param {Array} provinces
 * @param {{provIdx:number, ringIdx:number}} ref 参考顶点所在的省与环
 * @param {Array<number>} vertexIdxs 参考环上被拖动的顶点下标
 * @param {object} built `buildCoincidentIndex` 的返回值
 * @returns {{links: Array, truncated: boolean, sharedCount: number, provinces: number[]}}
 *   `links[i]` = `{ provIdx, ringIdx, vertexIdx, srcVertexIdx, dx, dy }`：
 *   把 `provIdx` 那个省的 `vertexIdx` 顶点按 `(dx, dy)` 平移，就与参考顶点严格重合。
 */
export function findLinkedVertices(provinces, ref, vertexIdxs, built, { quantum = VERTEX_QUANTUM } = {}) {
  const empty = { links: [], truncated: false, sharedCount: 0, provinces: [] };
  if (!built || !built.index || !Array.isArray(vertexIdxs) || !vertexIdxs.length) return empty;
  const prov = (provinces || [])[ref?.provIdx];
  if (!prov) return empty;
  const rings = provinceRings(prov);
  const ring = rings[ref.ringIdx] || rings[0];
  if (!ring) return empty;

  const links = [];
  const seen = new Set();
  const provSet = new Set();
  let truncated = false;
  for (const vi of vertexIdxs) {
    const p = ring.points[vi];
    if (!p) continue;
    const x = px(p);
    const y = py(p);
    const key = vertexKey(x, y, quantum);
    if (!key) continue;
    for (const hit of (built.index.get(key) || [])) {
      if (hit.provIdx === ref.provIdx && hit.ringIdx === ref.ringIdx) continue;   // 自己
      const sig = `${hit.provIdx}|${hit.ringIdx}|${hit.vertexIdx}`;
      if (seen.has(sig)) continue;
      if (links.length >= MAX_LINKED_VERTICES) { truncated = true; break; }
      seen.add(sig);
      provSet.add(hit.provIdx);
      links.push({
        provIdx: hit.provIdx,
        ringIdx: hit.ringIdx,
        vertexIdx: hit.vertexIdx,
        srcVertexIdx: vi,
        dx: x - hit.x,
        dy: y - hit.y,
      });
    }
    if (truncated) break;
  }
  return { links, truncated, sharedCount: links.length, provinces: [...provSet] };
}

/**
 * 把一组位移应用到一份顶点数组上（**返回新数组**，不就地改）。
 * Bezier 控制点 `controlIn/controlOut` 是**相对偏移**，跟着顶点走即可（原样带上）。
 */
export function shiftPoints(points, moves) {
  const out = (points || []).map((p) => {
    const q = { x: px(p), y: py(p) };
    if (p && p.controlIn) q.controlIn = { ...p.controlIn };
    if (p && p.controlOut) q.controlOut = { ...p.controlOut };
    return q;
  });
  for (const m of (moves || [])) {
    const p = out[m.idx];
    if (!p) continue;
    p.x += m.dx;
    p.y += m.dy;
  }
  return out;
}

/**
 * 框选命中：返回落在世界坐标矩形内的顶点下标。
 * 判据是**顶点的当前位置**（`points` 而非原始 JSON）—— 拖拽预览期间框选也该按看到的走。
 */
export function verticesInBox(points, box) {
  if (!Array.isArray(points) || !box) return [];
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const x = px(points[i]);
    const y = py(points[i]);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(i);
  }
  return out;
}
