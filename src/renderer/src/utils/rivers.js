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
