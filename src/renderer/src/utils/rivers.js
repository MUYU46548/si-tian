// utils/rivers.js — 河流编辑器核心算法（P1-1）
//
// 河流的本质约束是**流向**：水只能从高处往低处流。手工描点时用户不会按高度顺序点，
// 所以编辑器要能：① 自动按高度排序成从高到低 ② 拖拽节点时不允许把节点拖到"逆流"位置。
//
// 数据落点：mapData[planetId].rivers = [{ id, name, width, nodes: [{x, y, h}] }]
//   · h 是该点采样到的高度，随节点一起存 → 拖动时不必每次重新采样，也便于校验流向。
//
// 坐标系约定：高度来自行星高度图（0~100 左右的相对高度，海平面见 SEA_LEVEL）。

/** 判定"逆流"的容差：高度差小于该值视为持平（允许河流有一段平缓/湖泊） */
export const FLOW_EPSILON = 0.35;

/**
 * 采样高度（调用方注入 heightAt(x, y) → number|null）。
 * 取不到高度时回落到上游高度，保证排序稳定。
 */
export function sampleNodes(points, heightAt, fallbackH = 0) {
  const out = [];
  let lastH = fallbackH;
  for (const p of points || []) {
    const h = heightAt(p.x, p.y);
    const val = Number.isFinite(h) ? h : lastH;
    lastH = val;
    out.push({ x: p.x, y: p.y, h: val });
  }
  return out;
}

/**
 * 按高度从高到低重排节点（源头在前，入海在后）。
 * 稳定排序：高度相同的保持用户点击顺序，避免"点两下顺序乱跳"。
 */
export function normalizeRiverFlow(nodes) {
  return (nodes || [])
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (b.n.h - a.n.h) || (a.i - b.i))
    .map(x => x.n);
}

/** 列出逆流的相邻对（node[i].h < node[i+1].h），返回索引数组 */
export function flowViolations(nodes) {
  const out = [];
  for (let i = 0; i < (nodes?.length || 0) - 1; i++) {
    if (nodes[i + 1].h - nodes[i].h > FLOW_EPSILON) out.push(i);
  }
  return out;
}

/**
 * 约束拖拽：把河流第 index 个节点拖到 point 时，保证它仍落在
 * [下游高度, 上游高度] 区间内（上游 = index-1，下游 = index+1）。
 *
 * 处理策略（提示词要求"向高处拖拽自动 snapshot 或回退"）：
 *   · 越界不阻断操作，而是把点**贴到**最近的合法位置 —— 沿"上下端点连线"投影，
 *     返回吸附后的点，前端给用户一个提示（clamped=true）。
 *   · 端点（首/尾）：首点只需 ≥ 次点；尾点只需 ≤ 前点。
 *
 * @returns {{ point: {x:number,y:number,h:number}, clamped: boolean, reason: string|null }}
 */
export function clampRiverNode(nodes, index, point, heightAt) {
  const list = nodes || [];
  const h = heightAt(point.x, point.y);
  const target = { x: point.x, y: point.y, h: Number.isFinite(h) ? h : list[index]?.h ?? 0 };

  const prev = index > 0 ? list[index - 1] : null;
  const next = index < list.length - 1 ? list[index + 1] : null;
  const hi = prev ? prev.h - FLOW_EPSILON : Infinity;   // 不能高于上游
  const lo = next ? next.h + FLOW_EPSILON : -Infinity;  // 不能低于下游

  if (target.h <= hi && target.h >= lo) return { point: target, clamped: false, reason: null };

  // 越界：把目标点沿「上游→下游」连线投影到合法高度带的边界上
  const a = prev || { x: target.x, y: target.y, h: hi === Infinity ? target.h : hi };
  const b = next || { x: target.x, y: target.y, h: lo === -Infinity ? target.h : lo };
  const bound = target.h > hi ? hi : lo;
  let px = target.x;
  let py = target.y;
  const span = a.h - b.h;
  if (Number.isFinite(span) && Math.abs(span) > 1e-6) {
    const t = Math.min(1, Math.max(0, (a.h - bound) / span));
    px = a.x + (b.x - a.x) * t;
    py = a.y + (b.y - a.y) * t;
  }
  const reason = target.h > hi ? '河流只能从高处流向低处（已贴到上游高度）' : '河流不能低于下游高度（已贴到下游高度）';
  return { point: { x: px, y: py, h: bound }, clamped: true, reason };
}

/**
 * 整条河流按高度重新排序 + 去掉重复点（手工描点常有连点）。
 * 用于"双击完成"时的收尾。
 */
export function finalizeRiverNodes(points, heightAt) {
  const sampled = sampleNodes(points, heightAt);
  const dedup = [];
  for (const p of sampled) {
    const last = dedup[dedup.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) continue;
    dedup.push(p);
  }
  return normalizeRiverFlow(dedup);
}

/** 河流样式（当前版本线宽=比例流的简化：等宽 + 可调） */
export const RIVER_DEFAULT_WIDTH = 3;
export const RIVER_COLOR = '#3B82F6';
export const RIVER_WIDTH_MIN = 1;
export const RIVER_WIDTH_MAX = 12;

export function clampRiverWidth(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return RIVER_DEFAULT_WIDTH;
  return Math.min(RIVER_WIDTH_MAX, Math.max(RIVER_WIDTH_MIN, Math.round(n * 10) / 10));
}

/** 按流量分级给线宽（简化：节点越多 = 干流越宽），供"按流量画线宽"使用 */
export function widthByFlow(nodeCount, base = RIVER_DEFAULT_WIDTH) {
  if (nodeCount >= 40) return clampRiverWidth(base * 2);
  if (nodeCount >= 15) return clampRiverWidth(base * 1.5);
  return clampRiverWidth(base);
}

/** 在某段路径上插入节点（Shift+点击边上）：返回插入后的节点数组 */
export function insertNodeBetween(nodes, index, point, heightAt) {
  const list = (nodes || []).slice();
  const h = heightAt(point.x, point.y);
  list.splice(index + 1, 0, { x: point.x, y: point.y, h: Number.isFinite(h) ? h : (list[index]?.h ?? 0) });
  return normalizeRiverFlow(list);
}

export function findRiverPointIndex(nodes, x, y, radius) {
  let best = -1;
  let bestD = radius;
  (nodes || []).forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) { bestD = d; best = i; }
  });
  return best;
}

/**
 * 点到折线的最短距离（河流命中测试）。
 *
 * 🔴 2026-10-17：从 `PlanetMap.vue` **下沉到这里**。原来它是行星图里的私有函数，
 *    而剧本底图这次也要做河身命中 → 再抄一份就是"同一件事两套实现"，
 *    而这类偏差**不会报错**，只会让"两张图里点河身的手感不一样"（本项目反复踩过）。
 *    行星图现在也 import 这一份（对外行为一字不差）。
 *
 * ⚠️ 顶点本身不在任何**线段**上时会被低估：单点折线（len<2）返回 Infinity ——
 *    调用方一律先判 `nodes.length >= 2`。
 *
 * @param {number} px @param {number} py
 * @param {Array<{x:number,y:number}>} nodes
 */
export function distanceToPolyline(px, py, nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let best = Infinity;
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / L;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)));
  }
  return best;
}

/**
 * 命中一条河流（离点击点最近的、且在容差内的）。
 *
 * 与 `findRiverSegment` 的分工：本函数回答**哪条河**，`findRiverSegment` 回答**哪一段**。
 * 少任何一半都接不上「点河身加拐点」：只有段没河 → 不知道改哪条；只有河没段 → 不知道插哪。
 *
 * @param {Array<{id:string,nodes?:Array,points?:Array}>} list
 * @param {number} x @param {number} y @param {number} radius 容差（世界单位）
 * @param {(river:object)=>Array} [nodesOf] 取节点的口径（底图侧存 `points`、行星侧存 `nodes`）
 * @returns {object|null} 命中的**那一条**（原对象，不是拷贝）
 */
export function hitTestRiver(list, x, y, radius, nodesOf) {
  const pick = typeof nodesOf === 'function'
    ? nodesOf
    : (r) => (r && (r.nodes || r.points)) || [];
  let best = null;
  let bestD = Number.isFinite(radius) ? radius : Infinity;
  for (const r of (Array.isArray(list) ? list : [])) {
    if (!r) continue;
    const nodes = pick(r);
    if (!nodes || nodes.length < 2) continue;   // 单点折线没有"河身"可言
    const d = distanceToPolyline(x, y, nodes);
    if (d <= bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * 移动一个节点（**纯函数**：返回新数组，不改入参）。
 *
 * 为什么单独一个函数而不是在组件里 `nodes[i] = p`：拖动期间组件确实要"就地改"
 * 才不卡（见 ScenarioMap 的拖动分支），但**落库前**必须有一份与拖动无关的纯计算 ——
 * 否则「拖动预览」与「最终写入」就是两条算路（撤回来的位置与看到的不一样）。
 *
 * @param {Array} nodes @param {number} index
 * @param {{x:number,y:number,h?:number}} point
 * @returns {Array} 新数组；下标越界时原样返回（浅拷贝）
 */
export function replaceRiverNode(nodes, index, point) {
  const list = (nodes || []).map((p) => ({ ...p }));
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  const prev = list[index];
  const next = { x: point.x, y: point.y };
  // h 跟着走：`{x,y}` 的底图河没有 h，就不凭空补一个（否则数据里冒出无意义的 0）
  if (Number.isFinite(point.h)) next.h = point.h;
  else if (Number.isFinite(prev.h)) next.h = prev.h;
  list[index] = next;
  return list;
}

/**
 * 找离 (x,y) 最近的**线段**，返回线段起点下标与投影点。
 *
 * 🔴 2026-10-16 补：`insertNodeBetween(nodes, index, point, heightAt)` 要的是**线段起点下标**
 * （它做 `splice(index + 1, …)`），但本文件原先只有 `findRiverPointIndex`（最近**顶点**）——
 * 于是「点边上插入节点」这个能力**在几何上根本够不着**：只有恰好点在某个顶点上才知道插哪。
 * 这就是 `insertNodeBetween` 长期**零调用**的直接原因（本项目第五次「零调用死入口」）。
 *
 * @param {Array<{x:number,y:number}>} nodes
 * @param {number} x @param {number} y
 * @param {number} radius 命中容差（世界单位）；超出即返回 null
 * @returns {{index:number, point:{x:number,y:number}, dist:number}|null}
 *   `index` = 线段**起点**下标（0 基），`point` = 该点在段上的投影
 */
export function findRiverSegment(nodes, x, y, radius) {
  const n = (nodes || []).length;
  if (n < 2) return null;
  let best = null;
  let bestD = radius;
  for (let i = 0; i + 1 < n; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    // 退化段（两点重合）按端点处理，t 取 0
    let t = l2 > 1e-12 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d <= bestD) { bestD = d; best = { index: i, point: { x: px, y: py }, dist: d }; }
  }
  return best;
}
