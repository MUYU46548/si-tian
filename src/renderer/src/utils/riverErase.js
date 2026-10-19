// utils/riverErase.js — 河流「橡皮擦」的**纯几何**：按擦除轨迹把一条折线切成留下的几段。
//
// 为什么单开一个文件（而不是写在组件里）：这是**几何规则**，必须能被 Node 单测钉住
// （断成几段、边界算不算、单点段留不留、结点会不会被摊爆）。组件那份只负责把结果
// 翻译成 store 的原子写口（`applyBaseMapRiverEdit`）。
//
// 🔴 口径（都是踩过才知道的）：
//   ① **判定看"线的哪一段落在擦除轨迹的半径内"，不是"哪个节点落在里面"**。
//      河节点间距是按屏幕像素算的（`RIVER_NODE_SPACING_PX`=30px），橡皮半径 18px ⇒
//      直径 36px。正常情况相邻两点都进圈，但一条很长的河会被 `RIVER_MAX_NODES`（72）
//      截住 ⇒ 节点间距可以远超那个直径，那时"只判节点"的橡皮会出现**明明擦过去却没反应**。
//      所以先把折线按 `radius/2` **虚拟加密**一遍再判，最后只保留「原节点 + 每段切口」——
//      既不会漏，也不会把节点数摊爆（切口最多每段两个）。
//   ② **边界算"留"不算"擦"**（严格 `dist < radius` 才算命中，与仓里 `conformToSkeleton`
//      的阈值口径一致）。切口落在"圈外的第一个采样点"上，误差 ≤ radius/2（亚像素级）。
//   ③ 留下的段短于 `minRunPoints`（默认 2 —— 一条河至少 2 点）**丢弃**：
//      否则擦一下会留下一个孤零零的点，渲染成一个小圆点（用户看到的是"没擦干净"）。
//   ④ 完全没碰到 → `touched=false`，调用方**一个字节都不该写**（别压空撤销）。

const isPt = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** 点到线段的最短距离的平方（省一次开方；比距离是为了比较，平方就够） */
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + dx * t, qy = ay + dy * t;
  const ex = px - qx, ey = py - qy;
  return ex * ex + ey * ey;
}

/** 擦除轨迹的包围盒（带 pad）—— 用来对整条河做快速否定 */
export function strokeBounds(stroke, pad = 0) {
  const list = (stroke || []).filter(isPt);
  if (!list.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of list) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** 点到「擦除轨迹」这条折线的最短距离（轨迹只有 1 个采样点时退化成点到点） */
export function distanceToStroke(x, y, stroke) {
  const list = stroke || [];
  if (!list.length) return Infinity;
  if (list.length === 1) return Math.hypot(x - list[0].x, y - list[0].y);
  let best = Infinity;
  for (let i = 0; i + 1 < list.length; i++) {
    const d2 = segDist2(x, y, list[i].x, list[i].y, list[i + 1].x, list[i + 1].y);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** 折线包围盒 */
function polyBounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 按 `maxStep` 把折线虚拟加密 —— 返回的每一项都记得自己**从哪来**：
 * `srcT === 0` 表示它本身就是原节点（这些点在结果里必须原样保留）。
 */
function densifyVirtual(points, maxStep) {
  const out = [];
  const step = maxStep > 0 ? maxStep : 1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push({ x: a.x, y: a.y, srcT: 0, srcIdx: i });
    const b = points[i + 1];
    if (!b) break;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.floor(len / step);
    for (let k = 1; k <= n; k++) {
      const t = (k * step) / len;
      if (!(t > 0) || !(t < 1)) continue;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, srcT: t, srcIdx: i });
    }
  }
  return out;
}

/**
 * 擦除一条折线。
 *
 * @param {Array<{x:number,y:number}>} points 河流节点
 * @param {Array<{x:number,y:number}>} stroke 擦除轨迹采样（世界坐标）
 * @param {number} radius 擦除半径（世界单位；严格 `< radius` 才算命中）
 * @param {{minRunPoints?:number}} [opts]
 * @returns {{runs:Array<Array<{x:number,y:number}>>, touched:boolean,
 *            erasedNodes:number, droppedNodes:number, total:number}}
 *   `runs` = 留下来的连续段（每段 ≥ `minRunPoints` 点，且**已按原样保留原节点**）
 */
export function erasePolylineByStroke(points, stroke, radius, { minRunPoints = 2 } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter(isPt);
  const st = (Array.isArray(stroke) ? stroke : []).filter(isPt);
  const empty = { runs: [], touched: false, erasedNodes: 0, droppedNodes: 0, total: pts.length };
  if (!pts.length) return empty;
  const copy = () => pts.map((p) => ({ x: p.x, y: p.y }));
  if (!st.length || !(radius > 0)) {
    return { runs: pts.length >= minRunPoints ? [copy()] : [], touched: false,
             erasedNodes: 0, droppedNodes: pts.length >= minRunPoints ? 0 : pts.length, total: pts.length };
  }
  // 快速否定：整条河离擦除轨迹比 radius 还远 → 原样返回
  const sb = strokeBounds(st, radius);
  const pb = polyBounds(pts);
  if (pb.maxX < sb.minX || pb.minX > sb.maxX || pb.maxY < sb.minY || pb.minY > sb.maxY) {
    return { runs: pts.length >= minRunPoints ? [copy()] : [], touched: false,
             erasedNodes: 0, droppedNodes: pts.length >= minRunPoints ? 0 : pts.length, total: pts.length };
  }
  // 虚拟加密：步长 = radius/2（切口精度 ≤ radius/2）
  const V = densifyVirtual(pts, radius / 2);
  const mask = V.map((v) => distanceToStroke(v.x, v.y, st) < radius);
  const erasedNodes = mask.reduce((a, m) => a + (m ? 1 : 0), 0);
  if (!erasedNodes) {
    return { runs: pts.length >= minRunPoints ? [copy()] : [], touched: false,
             erasedNodes: 0, droppedNodes: pts.length >= minRunPoints ? 0 : pts.length, total: pts.length };
  }
  // 连续「未擦」段 → 只保留原节点与两端（切口）
  const runs = [];
  let dropped = 0;
  let i = 0;
  while (i < V.length) {
    if (mask[i]) { i += 1; continue; }
    let j = i;
    while (j + 1 < V.length && !mask[j + 1]) j += 1;
    const seg = V.slice(i, j + 1);
    const kept = [];
    for (let k = 0; k < seg.length; k++) {
      const v = seg[k];
      const isNode = v.srcT === 0;
      const isEdge = k === 0 || k === seg.length - 1;
      if (isNode || isEdge) {
        const last = kept[kept.length - 1];
        if (last && Math.hypot(last.x - v.x, last.y - v.y) < 1e-9) continue;   // 去掉重复点
        kept.push({ x: v.x, y: v.y });
      }
    }
    if (kept.length >= minRunPoints) runs.push(kept);
    else dropped += kept.length;
    i = j + 1;
  }
  return { runs, touched: true, erasedNodes, droppedNodes: dropped, total: pts.length };
}

/**
 * 把「擦除结果」翻译成**一次原子写**的载荷（改 / 加 / 删三样）。
 *
 * 规则（与 store 写口同口径）：
 *   · 整条被擦干净 → `removes`；
 *   · 只剩一段 → 改原河（**保住 id / 名字 / 宽度 / 归属**，用户视角是"这条河短了"）；
 *   · 断成多段 → 第一段留原 id，其余段作为**新河**追加（继承原宽度）。
 * @param {Array<object>} rivers 候选河流（调用方负责只传**手画**的：id 前缀 `river_`）
 * @param {Array<{x:number,y:number}>} stroke
 * @param {number} radius
 * @returns {{patches:Array, adds:Array, removes:string[], cut:number, erased:number}}
 */
export function planRiverErase(rivers, stroke, radius) {
  const patches = [];
  const adds = [];
  const removes = [];
  let cut = 0, erased = 0;
  for (const r of rivers || []) {
    if (!r || !Array.isArray(r.points) || r.points.length < 2) continue;
    const res = erasePolylineByStroke(r.points, stroke, radius, { minRunPoints: 2 });
    if (!res.touched) continue;
    erased += res.erasedNodes;
    if (!res.runs.length) { removes.push(r.id); cut += 1; continue; }
    if (res.runs.length > 1) cut += res.runs.length - 1;
    patches.push({ id: r.id, patch: { points: res.runs[0] } });
    for (let k = 1; k < res.runs.length; k++) {
      adds.push({
        points: res.runs[k],
        ...(Number.isFinite(Number(r.width)) ? { width: Number(r.width) } : {}),
      });
    }
  }
  return { patches, adds, removes, cut, erased };
}
