// interaction/mapGeometry.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数 + 三个只被本组读写的缓存）：
//   snapToGrid / rawPointsOf / rawTerrain / rawProvOf / resolvePoints / ringPointsOf /
//   writeRingsPatch / writeRingPoints / rawRingPointsList / currentProvince /
//   screenToWorld / worldToScreen / skeletonForTerrain / effectiveVertexSelection /
//   coincidentIndexFor / provIdxOf。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数（搬出后仍读写同名同一份）。
//
// ⚠️ 留在 SFC 的：`traceProvincePath` / `provincePathFor`（它们要 `traceShapePath` 与
//   `buildProvincePath` —— 两者是**后置工厂**的产物，顺序上不能挪到本模块前面）、
//   `snapToEdge` / `resolveSnapPoint`（要 `snapFeedback` 与它的定时器，定时器在 onUnmounted 里清）。

import { toRaw } from 'vue';
import { provinceRings, shapePatch } from '../../utils/provinceShape';
import { buildCoincidentIndex } from '../../utils/vertexSharing';
import { buildSkeleton } from '../../utils/provinceShape';

export function createMapGeometry(ctx) {
  const {
    GRID_STEP,
    activeRingIdx,
    baseMap,
    cameraScale,
    cameraX,
    cameraY,
    dragPreview,
    selectedProvince,
    snapToGridEnabled,
    vertexSelection,
  } = ctx;

function snapToGrid(world, bypass = false) {
  if (!snapToGridEnabled.value || bypass) return { x: world.x, y: world.y, snapped: false };
  return {
    x: Math.round(world.x / GRID_STEP) * GRID_STEP,
    y: Math.round(world.y / GRID_STEP) * GRID_STEP,
    snapped: true,
  };
}

function resolvePoints(prov) {
  if (dragPreview.value && dragPreview.value.provId === prov.id) return dragPreview.value.points;
  return ringPointsOf(prov);        // 顶点编辑作用于**活动环**（多环省份可在属性面板切换）
}

// ─────────────────────────────────────────────────────────────
// 绘制用的「去响应式」几何（P-0 实测：单帧 94ms 的主因）
//   `baseMap.value.terrain` 是 Pinia ref 里的对象 → 走 `.value` 读到的每个省份/顶点都是
//   Vue 响应式代理；drawProvinces / traceShapePath / 小地图每帧对 25930 个顶点做属性读取，
//   CPU profiler 里「Vue 响应式 get 陷阱」占 27%、`reactive()` 占 6%，`vx/vy` 占 9%。
//   渲染是纯读场景，取 toRaw 后的原始数组即可（toRaw 是 WeakMap 查表，可忽略成本）。
//   ⚠️ 只在**绘制**路径用；命中检测、编辑、store 写入仍走原来的响应式引用（避免脱钩）。
// ─────────────────────────────────────────────────────────────
function rawTerrain() {
  const t = baseMap.value?.terrain;
  return t ? toRaw(t) : null;
}

function rawPointsOf(prov) {
  if (dragPreview.value && dragPreview.value.provId === prov.id) return dragPreview.value.points;
  const pts = toRaw(prov).points;          // raw 对象上取到的是原始数组，不再创建代理
  return Array.isArray(pts) ? pts : (pts || []);
}

function rawProvOf(prov) {
  return toRaw(prov);
}

function ringPointsOf(prov, idx = activeRingIdx.value) {
  const rings = provinceRings(prov);
  const r = rings[idx] || rings[0];
  return r ? r.points : null;
}

/**
 * 把**多个环**的新顶点一次性写回省份（P1：顶点拖动可能同时牵涉一个省的另一个环 ——
 * 例如洞环与外环共用一个顶点）。
 * @param {Map<number, Array>} ringChanges ringIdx → 新顶点数组
 */
function writeRingsPatch(prov, ringChanges) {
  const rings = provinceRings(prov).map((r) => ({ points: r.points, kind: r.kind, fromGrid: r.fromGrid }));
  if (!rings.length) return null;
  for (const [idx, points] of ringChanges) {
    // 与 ringPointsOf 同口径：越界一律落到主环（否则手柄画在环 0、写回却被丢弃 = 静默 no-op）
    const i = idx >= 0 && idx < rings.length ? idx : 0;
    rings[i] = { ...rings[i], points };   // 形状被手工改过 → 不再是网格派生的，去掉 fromGrid
  }
  const patch = shapePatch(rings);
  // fromGrid 显式给出：手工改过的环不再算「网格派生」→ 渲染端不再对它做平滑
  return { kind: patch.kind || 'land', points: patch.points, extraRings: patch.extraRings, fromGrid: !!patch.fromGrid };
}

function writeRingPoints(prov, idx, points) {
  return writeRingsPatch(prov, new Map([[idx, points]]));
}

function rawRingPointsList(prov) {
  const rp = toRaw(prov);
  return provinceRings(rp).map((r) => toRaw(r.points)).filter((pts) => Array.isArray(pts) && pts.length);
}

function currentProvince() {
  const sp = selectedProvince.value;
  if (!sp) return null;
  return baseMap.value?.terrain?.find(p => p.id === sp.id) || sp;
}

// ═══════════════════════════════════════════
// 坐标转换
// ═══════════════════════════════════════════
function screenToWorld(sx, sy) {
  return {
    x: (sx - cameraX.value) / cameraScale.value,
    y: (sy - cameraY.value) / cameraScale.value,
  };
}

/**
 * 世界坐标 → **画布内**屏幕坐标（`screenToWorld` 的逆）。
 *
 * 🔴 为什么要有这个函数（2026-10-17，我自己踩的坑）：真机探针里我手写
 *    `sc.cameraX + wx * sc.cameraScale` 来算点击位置 —— 而 `sc` 是组件实例代理，
 *    **ref 不会在那里解包**，于是 `sc.cameraX` 拿到的是 ref 对象，
 *    整个表达式变成 `[object] + wx * [object]` → 点在了别处，
 *    我还以为"节点拖不动"。有了这枚函数，探针与产品走**同一个换算**，
 *    这类"测试自己算错"就不会再伪装成产品缺陷。
 */
function worldToScreen(wx, wy) {
  return {
    x: cameraX.value + wx * cameraScale.value,
    y: cameraY.value + wy * cameraScale.value,
  };
}

let skeletonCache = null;           // { terrain, skeleton }
function skeletonForTerrain(terrain) {
  if (skeletonCache && skeletonCache.terrain === terrain) return skeletonCache.skeleton;
  const built = buildSkeleton(terrain);
  skeletonCache = { terrain, skeleton: built };
  return built;
}

function effectiveVertexSelection(vertexIdx) {
  const sel = vertexSelection.value || [];
  return sel.indexOf(vertexIdx) >= 0 ? sel.slice() : [vertexIdx];
}

let vertexIndexCache = null;   // { terrain, built }
function coincidentIndexFor(terrain) {
  if (vertexIndexCache && vertexIndexCache.terrain === terrain) return vertexIndexCache.built;
  const built = buildCoincidentIndex(terrain);
  vertexIndexCache = { terrain, built };
  return built;
}

function provIdxOf(prov) {
  const terrain = baseMap.value?.terrain || [];
  return terrain.findIndex((p) => p.id === prov.id);
}

  return {
    snapToGrid,
    rawPointsOf,
    rawTerrain,
    rawProvOf,
    resolvePoints,
    ringPointsOf,
    writeRingsPatch,
    writeRingPoints,
    rawRingPointsList,
    currentProvince,
    screenToWorld,
    worldToScreen,
    skeletonForTerrain,
    effectiveVertexSelection,
    coincidentIndexFor,
    provIdxOf,
  };
}
