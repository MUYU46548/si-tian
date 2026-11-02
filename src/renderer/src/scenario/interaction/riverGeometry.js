// interaction/riverGeometry.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数 + `riverPreviewCache` 这个
// 只被 `riverPreviewNodes` 读写的缓存）：
//   riverNodesFromDraft / riverPreviewNodes / draftWorldLength / riverFlowGate /
//   riverMinWidthForNet / handDrawnRivers / hitBaseMapRiver / snapToPolyline /
//   hitHandRiverBranchAnchor / segmentsProperlyIntersect / segmentHits / countPolylineCrossings /
//   countSelfCrossings / riverSideRef / sideOfLine / countCrossingsWithExisting /
//   hitRiverNodeIndex / moveRiverNodeTo / riverNodesForRender。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数 / 常量（搬出后仍读写同名同一份）；
//   纯函数工具直接 import。
//
// ⚠️ 留在 SFC 的：`enterRiverToolForSelected`（要 `setTool`，那是后置工厂的产物）、
//   `RIVER_*` 那批常量（它们的注释在 SFC 里是参数口径的唯一说明，搬走会拆散上下文）。

import { decimatePolyline, fitPolylineToCount, smoothRiverNodes } from '../../utils/polylineSmooth';
import { riverFlowGateByQuantile } from '../../utils/riverRender';
import { findRiverPointIndex, hitTestRiver } from '../../utils/rivers';

export function createRiverGeometry(ctx) {
  const { st, ...rest } = ctx;
  const {
    RIVER_BRANCH_SNAP_PX,
    RIVER_FLOW_KEEP_RATIO,
    RIVER_HIT_PX,
    RIVER_MAX_NODES,
    RIVER_MIN_NODES,
    RIVER_NET_CELL_PX_OK,
    RIVER_NET_MIN_PX_BASE,
    RIVER_NET_MIN_PX_MAX,
    RIVER_NODE_SPACING_PX,
    RIVER_TRACE_MIN_STEP_PX,
    autoRiverSegments,
    baseMap,
    baseMapKey,
    cameraScale,
    px,
    renderCoalesced,
    riverDrag,
    riverDraft,
    selectedRiver,
    store,
  } = rest;

/**
 * 笔迹 → **落库节点**（预览与落库的**唯一**几何链；2026-10-18 第十八修·四）。
 *
 * 🔴 暮雨原话：「河流要不要尝试其他画法？应该更偏向手绘吗（甚至有橡皮擦来擦除）……
 *    不要搞成描点连线模拟器」。其中"模拟器"的观感有一半来自**画的和落库的不是一条**：
 *    拖动时预览走 `smoothWhileDrawing`，抬手落库走「抽稀 → 压点数 → Chaikin」——
 *    两条链的手感与形状都不同，用户看到的是"松手之后形状跳了一下"。
 *    现在两条路**逐点相同**（回归 `test_122` 按点比对）。
 *
 * **三步走，顺序不能换**（2026-10-17 第六修，用户截图"画出来一堆点而不是线"）：
 *    ① 抽稀：丢掉过密的采样点（按屏幕 px 口径）；
 *    ② **压到目标点数**：按弧长均匀取样 —— 这一步决定"节点间距不会小于约 18 屏幕像素"；
 *    ③ 平滑：Chaikin **只跑 1 轮**（点已经不多，1 轮足够切角；2 轮会把点数再乘 2）。
 *    旧实现缺 ②、且 ③ 跑 2 轮 → 点数 ×4 → 节点手柄糊成一条虚线。
 *
 * @returns {{raw:Array, wantNodes:number, fitted:Array, pts:Array}}
 */
function riverNodesFromDraft(draft) {
  const raw = decimatePolyline((draft || []).map((p) => ({ x: p.x, y: p.y })), px(RIVER_TRACE_MIN_STEP_PX));
  if (raw.length < 2) return { raw, wantNodes: 0, fitted: raw, pts: raw };
  const wantNodes = Math.max(RIVER_MIN_NODES, Math.min(RIVER_MAX_NODES,
    Math.round(draftWorldLength(raw) / px(RIVER_NODE_SPACING_PX))));
  const fitted = fitPolylineToCount(raw, wantNodes, { minCount: RIVER_MIN_NODES, maxCount: RIVER_MAX_NODES });
  const pts = fitted.length >= 3 ? smoothRiverNodes(fitted, 1) : fitted;
  return { raw, wantNodes, fitted, pts };
}


function riverPreviewNodes() {
  const draft = riverDraft.value || [];
  if (draft.length < 2) return [];
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (now - st.riverPreviewCache.at < 60) return st.riverPreviewCache.pts;
  const pts = riverNodesFromDraft(draft).pts;
  st.riverPreviewCache = { at: now, pts };
  return pts;
}

function draftWorldLength(pts) {
  let sum = 0;
  for (let i = 0; i + 1 < (pts || []).length; i++) {
    sum += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return sum;
}

/**
 * 自动河网的**流量闸门**（绝对流量值）—— 走**分位口径**。
 *
 * 🔴 判据来源（两次实测，第一次的结论是错的，都在这里留档）：
 *   · 第一版用 `segMaxFlow × 0.25`（按上界取比例）。圆丘数据上还行（留 1/8），
 *     但在**真实分布**上直接崩：那份数据段汇流 `p50 = 2`、`max = 1275`（极端长尾），
 *     0.25×1275 = 319 → 3750 段只留 **26 段**（0.7%）→ 画布上几乎什么都没有
 *     （回归 `test_103` 当场抓住："画布上找不到自带河色的像素"）。
 *   · 现在按**分位**（留流量最高的 `RIVER_FLOW_KEEP_RATIO`）—— 与分布形状无关。
 * 🔴 教训的完整版：**归一化的对象是分布，不是最大值**。
 */
function riverFlowGate(segMax, segments) {
  const list = Array.isArray(segments) ? segments : autoRiverSegments.value;
  const gate = riverFlowGateByQuantile(list, RIVER_FLOW_KEEP_RATIO);
  if (gate > 0) return gate;
  // 兜底（没有段数据时按上界比例）
  const m = Number.isFinite(segMax) && segMax > 1 ? segMax : 0;
  return m > 0 ? Math.max(2, m * RIVER_FLOW_KEEP_RATIO) : 0;
}

/**
 * 河网的**屏幕像素线宽下限** —— 让"这份数据在当前缩放下还有没有意义"决定画多粗。
 *
 * 🔴 为什么需要（用户：「恐怖谷」的几何成因，本轮实测）：
 *    段是"格→格"，**一格的屏幕尺寸 = 格距 × 缩放**。缩到 10% 时一格只有 1.4 屏幕像素 →
 *    一万根 1~2 像素的短线并排 = 一片**平行斜线网格**（不是河，是布纹）。
 *    真实地图在这种比例尺下**根本不画细支流**。
 *    所以：一格 ≥ 6px 时按自带河口径（0.7px 起）；一格只有 1.4px 时抬到 2.2px ——
 *    细到"看不见"的段自然被更粗的主干盖过，网络才不会变成布纹。
 */
function riverMinWidthForNet() {
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  const spacing = Number(hm && hm.grid && hm.grid.spacing) || 0;
  const scale = cameraScale.value || 0;
  if (!(spacing > 0) || !(scale > 0)) return RIVER_NET_MIN_PX_BASE;
  const cellPx = spacing * scale;
  if (cellPx >= RIVER_NET_CELL_PX_OK) return RIVER_NET_MIN_PX_BASE;
  const t = Math.max(0, Math.min(1, cellPx / RIVER_NET_CELL_PX_OK));
  return RIVER_NET_MIN_PX_BASE + (RIVER_NET_MIN_PX_MAX - RIVER_NET_MIN_PX_BASE) * (1 - t);
}

function handDrawnRivers() {
  return (baseMap.value?.rivers || []).filter((r) => r && String(r.id || '').indexOf('river_') === 0);
}

function hitBaseMapRiver(wx, wy) {
  const tol = px(RIVER_HIT_PX);
  return hitTestRiver(handDrawnRivers(), wx, wy, tol);
}

function snapToPolyline(w, points) {
  const pts = Array.isArray(points) ? points : [];
  if (!w || pts.length === 0) return null;
  if (pts.length === 1) return { point: { x: pts[0].x, y: pts[0].y }, dist: Math.hypot(w.x - pts[0].x, w.y - pts[0].y), segIndex: 0 };
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2)) : 0;
    const px2 = a.x + dx * t, py2 = a.y + dy * t;
    const dist = Math.hypot(w.x - px2, w.y - py2);
    if (!best || dist < best.dist) best = { point: { x: px2, y: py2 }, dist, segIndex: i };
  }
  return best;
}

function hitHandRiverBranchAnchor(wx, wy) {
  const tol = px(RIVER_BRANCH_SNAP_PX);
  let best = null;
  for (const r of handDrawnRivers()) {
    const s = snapToPolyline({ x: wx, y: wy }, r && r.points);
    if (s && s.dist <= tol && (!best || s.dist < best.dist)) best = { river: r, point: s.point, dist: s.dist };
  }
  return best;
}

/**
 * 两条线段是否相交（**含端点接触与共线重叠**）。
 *
 * 🔴 2026-10-18 第十五修·补：第一版只判"严格跨立"（四个叉积异号）—— 用户手画的河
 *    常常是**轴对齐的**（一笔拉直、或横平竖直），于是"穿过去"恰好落在母河的**顶点**上：
 *    四个叉积里有一个是 0，严格判据返回 false ⇒ **交叉怪物照样落库**
 *    （探针实测：一条水平笔画过一条竖线的中点，`worst=0`）。
 *    端点接触必须算相交：拓扑上它就是"穿过"。
 */
function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const EPS = 1e-9;
  const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSeg = (a, b, c) => Math.abs(o(a, b, c)) <= EPS
    && Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS
    && Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS;
  const o1 = o(p3, p4, p1), o2 = o(p3, p4, p2), o3 = o(p1, p2, p3), o4 = o(p1, p2, p4);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
      && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  // 退化情形：端点落在另一条线段上 / 共线重叠
  if (onSeg(p3, p4, p1) || onSeg(p3, p4, p2) || onSeg(p1, p2, p3) || onSeg(p1, p2, p4)) return true;
  return false;
}

function segmentHits(p1, p2, p3, p4) {
  return segmentsProperlyIntersect(p1, p2, p3, p4);
}

function countPolylineCrossings(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  let n = 0;
  for (let i = 0; i + 1 < A.length; i++) {
    for (let j = 0; j + 1 < B.length; j++) {
      if (segmentHits(A[i], A[i + 1], B[j], B[j + 1])) n++;
    }
  }
  return n;
}

function countSelfCrossings(pts) {
  const P = Array.isArray(pts) ? pts : [];
  let n = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    for (let j = i + 2; j + 1 < P.length; j++) {
      if (segmentsProperlyIntersect(P[i], P[i + 1], P[j], P[j + 1])) n++;
    }
  }
  return n;
}

/**
 * 给一条折线当"侧向测试基准"的一段（取**最长**的那一段，最能代表这条河的走向）。
 * @returns {{a:{x:number,y:number}, b:{x:number,y:number}}|null}
 */
function riverSideRef(points) {
  const pts = Array.isArray(points) ? points : [];
  let best = null;
  let bestLen = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (len > bestLen) { bestLen = len; best = { a: pts[i], b: pts[i + 1] }; }
  }
  return best;
}

function sideOfLine(a, b, p) {
  const v = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return v > 1e-9 ? 1 : (v < -1e-9 ? -1 : 0);
}

/**
 * 这一笔**横切了哪几条河** —— 「交叉怪物」的结构性判据。
 *
 * 🔴 口径迭代了三次，每一次都是被判据教出来的（据实记下来，免得下一个人走回头路）：
 *    ① **只统计"与任何已有河有 ≥2 交点"** → 把**搭桥、正当交汇**也拒了
 *       （test_95 立刻红：一笔普通的新河恰好斜穿两条已有河）。
 *    ② 收紧成"**同一条河**上 ≥2 交点" → 还是把"穿过两条河各一次"误当成怪物
 *       （test_95 依然红：draft 的两段各穿第一条河一次 = 同一条河 2 个交点）。
 *    ③ 现在按**形状**判（这才是用户说的"交叉怪物"）：一笔从河的一侧出去、**又绕回同一侧**，
 *       于是同一条河被穿过 ≥2 次。判据 = 交点 ≥2 **且** 笔迹首尾在该河同侧
 *       （真的"穿过去"首尾必然异侧）。
 *    ⚠️ 代价（据实说）：首尾同侧的"来回穿两次"才拦；一笔横穿好几条不同的河不拦
 *       （那是正当交汇，用户可用 Ctrl+Z）。
 */
function countCrossingsWithExisting(draft, minPerRiver = 2) {
  const P = Array.isArray(draft) ? draft : [];
  let total = 0;
  let worst = 0;
  if (P.length < 2) return { total, worst };
  const head = P[0], tail = P[P.length - 1];
  for (const r of handDrawnRivers()) {
    const n = countPolylineCrossings(P, r && r.points);
    if (n < minPerRiver) continue;
    const ref = riverSideRef(r && r.points);
    if (!ref) continue;
    const s0 = sideOfLine(ref.a, ref.b, head);
    const s1 = sideOfLine(ref.a, ref.b, tail);
    if (s0 === 0 || s1 === 0) continue;      // 有一端就落在河上 → 那是"接在上面"，不是横切
    if (s0 !== s1) continue;                  // 首尾异侧 = 真的穿过去了（回去查是桥/交汇）
    total += n;
    if (n > worst) worst = n;
  }
  return { total, worst };
}

function hitRiverNodeIndex(wx, wy) {
  const r = selectedRiver.value;
  if (!r) return -1;
  // ⚠️ 底图河的节点数组字段是 **`points`**（`addBaseMapRiver` / `normalizeBaseMapRivers`
  //    与 `drawRiverPaths` 全都读它）。行星图那边叫 `nodes` —— 别顺手写错，
  //    写错的后果是"能选中但拖不动"（`r.nodes` 恒 undefined）。
  const nodes = r.points || [];
  if (nodes.length < 2) return -1;
  return findRiverPointIndex(nodes, wx, wy, px(RIVER_HIT_PX));
}

/** 拖动中：**只动拖动草稿**（`riverDrag.points`），松手才一条提交。
 *
 * 🔴 为什么不用"就地改 `selectedRiver.points[i]`"（2026-10-17，实测踩到）：
 *    看着更省，但拖动期间读到的那条河**不保证是 store 里那条对象** ——
 *    本仓在项目↔画布接线上踩过同款（按引用持有的当前节点会脱钩）。
 *    症状是"按住节点拖，松手后坐标没变"（日志里 `commit changed=true`，
 *    而 store 里的点纹丝不动）。改成**显式草稿**之后，"画什么"与"存什么"
 *    各有唯一来源，也不再依赖对象身份。与同文件顶点拖动的 `dragPreview` 同款。
 */
function moveRiverNodeTo(world) {
  const drag = riverDrag.value;
  const r = selectedRiver.value;
  if (!drag || !r || drag.riverId !== r.id) return;
  if (!drag.points || !drag.points[drag.index]) return;
  drag.points[drag.index] = { x: world.x, y: world.y };
  // 拖节点是高频手势 → 帧合并；松手时 `commitRiverDrag` 会用同步 `render()` 收口
  renderCoalesced();
}

function riverNodesForRender(r) {
  const drag = riverDrag.value;
  if (drag && r && drag.riverId === r.id && drag.points) return drag.points;
  return (r && r.points) || [];
}

  return {
    riverNodesFromDraft,
    riverPreviewNodes,
    draftWorldLength,
    riverFlowGate,
    riverMinWidthForNet,
    handDrawnRivers,
    hitBaseMapRiver,
    snapToPolyline,
    hitHandRiverBranchAnchor,
    segmentsProperlyIntersect,
    segmentHits,
    countPolylineCrossings,
    countSelfCrossings,
    riverSideRef,
    sideOfLine,
    countCrossingsWithExisting,
    hitRiverNodeIndex,
    moveRiverNodeTo,
    riverNodesForRender,
  };
}
