// interior/stairs.js — 楼梯的几何（纯函数，2026-11-15，台账 A24 / A16 / A14）
//
// ── 为什么独立成文件 ──────────────────────────────────────────────────────
// 一部楼梯要被**三处**同时读到，而且三处必须完全一致：
//   ① 平面图（`renderFloor.js`）：踏步线、上下行箭头、洞口虚线
//   ② 3D 外壳（`buildShell.js`）：每级踏步一个体块 + 楼板上的洞
//   ③ 楼层数据（`InteriorView.vue`）：选中/改级数/改宽度时的数值反馈
// 三处各算一遍 = 三份真相，改了踏步数平面图变了而 3D 不变（本项目最怕的静默不一致）。
//
// ── 口径 ─────────────────────────────────────────────────────────────────
//   · 世界单位 = 厘米（与 `utils/interiorUnits.js`、墙/家具同一口径）。
//   · `start` = **起步端**（本层地面这一头），`end` = **上落端**（上一层地面这一头）；
//     两点连线是梯段中心线，梯段宽 `width` 向两侧各铺 `width/2`。
//   · `direction: 'up'`（默认）= 从本层上到**上一层**；`'down'` = 从本层下到**下一层**。
//     两种都画在“人站着的这一层”，区别只在于洞口开在哪块楼板、踏步往哪边升。
//   · 升量 `rise` = 目标层标高 − 本层标高（cm，可负）。没有目标层时按 300（默认层高）估。
//
// ── 纪律 ─────────────────────────────────────────────────────────────────
// 🔴 不 import 任何模块：Node 单测把本文件当 data URL 直接载入（`unit/test_stairs.js`），
//    有一条 import 就加载不了。需要别的常量的地方一律本文件自带。
// 🔴 洞与板同源：楼板挖洞用的矩形就是本文件 `stairHolePolygon()` 的结果，
//    不许在 buildShell 里另写一套“大概在这个位置挖个方洞”。

export const STAIR_DEFAULTS = Object.freeze({
  width: 100,          // 梯段宽（cm），住宅双跑的一半常见 100~120
  riseStep: 17.5,      // 单级踏步高目标（cm）
  minSteps: 4,
  maxSteps: 40,
  treadThickness: 12,  // 3D 踏步板厚（cm）
  holeMargin: 10,      // 洞口在梯段四周多留的余量（cm）：扶手/施工缝
  fallbackFloorHeight: 300,
  color: '#b9a888',
});

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 梯段中心线的几何：起点、终点、长度、单位方向、绕 Y 角（与墙同一套换算） */
export function stairAxis(stair) {
  const x0 = num(stair && stair.start && stair.start.x);
  const y0 = num(stair && stair.start && stair.start.y);
  const x1 = num(stair && stair.end && stair.end.x);
  const y1 = num(stair && stair.end && stair.end.y);
  const ddx = x1 - x0;
  const ddy = y1 - y0;
  const len = Math.hypot(ddx, ddy);
  const dx = len > 1e-6 ? ddx / len : 1;
  const dy = len > 1e-6 ? ddy / len : 0;
  return { x: x0, y: y0, x1, y1, len, dx, dy, rotY: Math.atan2(-dy, dx) };
}

/** 方向（缺省 up——老数据/新画的都当上行） */
export function stairDirection(stair) {
  return stair && stair.direction === 'down' ? 'down' : 'up';
}

/**
 * 升量（cm，可负）：目标层标高 − 本层标高。
 * @param {object} stair
 * @param {{ownElevation?:number, targetElevation?:number}} [opts]
 */
export function stairRise(stair, opts = {}) {
  const own = num(opts.ownElevation, 0);
  const target = Number(opts.targetElevation);
  if (Number.isFinite(target)) return target - own;
  return stairDirection(stair) === 'down'
    ? -STAIR_DEFAULTS.fallbackFloorHeight
    : STAIR_DEFAULTS.fallbackFloorHeight;
}

/**
 * 踏步级数：用户给了就按给的（1~40，1 级也是合法台阶），
 * `0`/缺省 = **自动**：按目标踏步高反算（至少 4 级）。
 *
 * 为什么不把 1~3 悄悄改成"自动"：用户填 3 就是想要 3 级（下沉台阶），
 * 程序替他改成 17 级是最糟的那种"体贴"。
 */
export function stairStepCount(stair, rise) {
  const given = Math.round(num(stair && stair.steps, 0));
  if (given >= 1) return clamp(given, 1, STAIR_DEFAULTS.maxSteps);
  const abs = Math.abs(num(rise, STAIR_DEFAULTS.fallbackFloorHeight)) || STAIR_DEFAULTS.fallbackFloorHeight;
  return clamp(Math.round(abs / STAIR_DEFAULTS.riseStep), STAIR_DEFAULTS.minSteps, STAIR_DEFAULTS.maxSteps);
}

/**
 * 每级踏步：`t0/t1` 是沿中心线的归一化区间（0=起步端，1=上落端），
 * `level` 是这一级**踏面**相对本层地面的高度（cm，上行时为正、下行时为负）。
 *
 * 返回按“由低到高行走顺序”排列：上行从 start 往 end，下行也从 start 往 end（往下走）。
 */
export function stairTreads(stair, opts = {}) {
  const axis = stairAxis(stair);
  const rise = stairRise(stair, opts);
  const n = stairStepCount(stair, rise);
  const width = Math.max(40, num(stair && stair.width, STAIR_DEFAULTS.width) || STAIR_DEFAULTS.width);
  const thickness = clamp(Math.abs(rise / n) * 0.55, 6, 22) || STAIR_DEFAULTS.treadThickness;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      t0: i / n,
      t1: (i + 1) / n,
      level: (rise * (i + 1)) / n,
      width,
      thickness,
    });
  }
  return { axis, rise, steps: n, width, thickness, treads: out };
}

/**
 * 梯段平面投影（4 个角，世界坐标）。宽度向两侧各铺 width/2，长度方向不外扩。
 * 顺带返回中心线两端，画箭头用。
 */
export function stairFootprint(stair, opts = {}) {
  const axis = stairAxis(stair);
  const half = Math.max(20, num(stair && stair.width, STAIR_DEFAULTS.width) || STAIR_DEFAULTS.width) / 2;
  const nx = -axis.dy;
  const ny = axis.dx;
  return {
    axis,
    halfWidth: half,
    poly: [
      { x: axis.x + nx * half, y: axis.y + ny * half },
      { x: axis.x1 + nx * half, y: axis.y1 + ny * half },
      { x: axis.x1 - nx * half, y: axis.y1 - ny * half },
      { x: axis.x - nx * half, y: axis.y - ny * half },
    ],
  };
}

/**
 * 楼板洞口（世界坐标多边形）：梯段投影四周外扩 `holeMargin`。
 * 上落端多留一点（人从洞口走出来的那一段），起步端少留。
 */
export function stairHolePolygon(stair, opts = {}) {
  const axis = stairAxis(stair);
  const margin = num(opts.margin, STAIR_DEFAULTS.holeMargin);
  const half = Math.max(20, num(stair && stair.width, STAIR_DEFAULTS.width) || STAIR_DEFAULTS.width) / 2 + margin;
  const nx = -axis.dy;
  const ny = axis.dx;
  // 沿中心线外扩：起步端 margin/2，上落端 margin
  const back = margin * 0.5;
  const fore = margin;
  const sx = axis.x - axis.dx * back;
  const sy = axis.y - axis.dy * back;
  const ex = axis.x1 + axis.dx * fore;
  const ey = axis.y1 + axis.dy * fore;
  return [
    { x: sx + nx * half, y: sy + ny * half },
    { x: ex + nx * half, y: ey + ny * half },
    { x: ex - nx * half, y: ey - ny * half },
    { x: sx - nx * half, y: sy - ny * half },
  ];
}

/**
 * 楼梯的 3D 盒子（踏步板）：每级一块，顶面在该级踏面标高上。
 *
 * 不做“实心台阶块”：实心块会把洞口糊住，轴测图里看不到“通到上一层”这件事；
 * 薄板 + 墨线（`axoScene` 的 EdgesGeometry）反而一眼读得出这是楼梯。
 */
export function stairBoxes(stair, opts = {}) {
  const own = num(opts.ownElevation, 0);
  const g = stairTreads(stair, opts);
  const { axis } = g;
  const boxes = [];
  const rotY = axis.rotY;
  for (const t of g.treads) {
    const mid = (t.t0 + t.t1) / 2;
    const cx = axis.x + axis.dx * axis.len * mid;
    const cz = axis.y + axis.dy * axis.len * mid;
    boxes.push({
      kind: 'stair',
      color: opts.color || STAIR_DEFAULTS.color,
      cx,
      // 踏面在 level，板往下长（上行/下行都一样：顶面 = 这一级踏面）
      cy: own + t.level - t.thickness / 2,
      cz,
      sx: Math.max(1, axis.len / g.steps),
      sy: t.thickness,
      sz: g.width,
      rotY,
      stairIndex: t.index,
    });
  }
  return boxes;
}

// ── 矩形差集（楼板挖洞）──────────────────────────────────────────────────

/** 归一化矩形（保证 u0<u1 / v0<v1） */
function normRect(r) {
  if (!r) return null;
  const u0 = Math.min(num(r.u0), num(r.u1));
  const u1 = Math.max(num(r.u0), num(r.u1));
  const v0 = Math.min(num(r.v0), num(r.v1));
  const v1 = Math.max(num(r.v0), num(r.v1));
  if (!(u1 - u0 > 1e-9) || !(v1 - v0 > 1e-9)) return null;
  return { u0, u1, v0, v1 };
}

/**
 * 矩形差集：把 `rect` 里若干矩形洞挖掉，返回**互不重叠**的实心小矩形。
 *
 * 为什么不用布尔库：楼板是一块矩形，洞是几个矩形（楼梯洞 + 手画洞），
 * 这个特例有确定性解法（纵向切片 + 逐片取补），30 行、可单测、没有退化风险。
 * 多边形级布尔留给省份几何（那边确实需要，`utils/polygonBool.js`）。
 *
 * @param {{u0:number,u1:number,v0:number,v1:number}} rect
 * @param {Array<{u0:number,u1:number,v0:number,v1:number}>} holes
 * @returns {Array<{u0:number,u1:number,v0:number,v1:number}>}
 */
export function subtractRects(rect, holes = []) {
  const r = normRect(rect);
  if (!r) return [];
  const list = (holes || [])
    .map(normRect)
    .filter((h) => h && h.u0 < r.u1 - 1e-9 && h.u1 > r.u0 + 1e-9 && h.v0 < r.v1 - 1e-9 && h.v1 > r.v0 + 1e-9)
    .map((h) => ({
      u0: Math.max(h.u0, r.u0), u1: Math.min(h.u1, r.u1),
      v0: Math.max(h.v0, r.v0), v1: Math.min(h.v1, r.v1),
    }));
  if (!list.length) return [r];

  // 纵向切片：所有拐点当切缝（含矩形自己的两端）
  const us = [r.u0, r.u1];
  for (const h of list) us.push(h.u0, h.u1);
  const cuts = [...new Set(us.map((u) => clamp(u, r.u0, r.u1)))].sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const u0 = cuts[i];
    const u1 = cuts[i + 1];
    if (!(u1 - u0 > 1e-6)) continue;
    const mid = (u0 + u1) / 2;
    // 这一片里被洞盖住的竖直区间（合并重叠）
    const spans = list
      .filter((h) => h.u0 <= mid && mid <= h.u1)
      .map((h) => [h.v0, h.v1])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    let cursor = r.v0;
    for (const [a, b] of merged) {
      if (a - cursor > 1e-6) out.push({ u0, u1, v0: cursor, v1: a });
      cursor = Math.max(cursor, b);
    }
    if (r.v1 - cursor > 1e-6) out.push({ u0, u1, v0: cursor, v1: r.v1 });
  }
  return out;
}

// ── 楼层视角：本层楼板上的洞 ─────────────────────────────────────────────

/**
 * 按标高升序排楼层（与 `buildShell` / 楼层标签同一口径：
 * 先比 elevation，再比 level，再比原顺序 —— 排序必须稳定，否则同标高的两层会来回换位）。
 */
export function orderFloorsByElevation(floors) {
  const list = (Array.isArray(floors) ? floors : []).filter(Boolean);
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ea = num(a.f.elevation, 0);
      const eb = num(b.f.elevation, 0);
      if (Math.abs(ea - eb) > 1e-6) return ea - eb;
      const la = num(a.f.level, a.i);
      const lb = num(b.f.level, b.i);
      if (Math.abs(la - lb) > 1e-6) return la - lb;
      return a.i - b.i;
    })
    .map((x) => x.f);
}

/**
 * 某一层楼板上该有几个洞（世界坐标多边形 + 来源）。
 *
 * 口径：楼板归属**下面的那一层** —— `floors[i]` 的楼板是“i-1 层爬到 i 层”的踏板。
 * 所以：
 *   · 下层（i-1）的上行楼梯 → 洞在 i 层楼板
 *   · 本层（i）的下行楼梯   → 洞也在 i 层楼板（往下走的那截要从这块板穿过去）
 *
 * @returns {Array<{stairId:string, direction:string, floorId:string, poly:Array}>}
 */
export function stairHolesForFloor(floors, floorId, opts = {}) {
  const ordered = orderFloorsByElevation(floors);
  const idx = ordered.findIndex((f) => f.id === floorId);
  if (idx < 0) return [];
  const own = ordered[idx];
  const below = idx > 0 ? ordered[idx - 1] : null;
  const out = [];
  const push = (stair, fromFloor, direction) => {
    if (!stair) return;
    out.push({
      stairId: stair.id,
      direction,
      floorId: fromFloor && fromFloor.id,
      poly: stairHolePolygon(stair, opts),
    });
  };
  for (const s of (below && below.stairs) || []) {
    if (stairDirection(s) === 'up') push(s, below, 'up');
  }
  for (const s of own.stairs || []) {
    if (stairDirection(s) === 'down') push(s, own, 'down');
  }
  return out;
}

/**
 * 一部楼梯的“目标层”（上行 = 上一层；下行 = 下一层），没有就返回 null。
 * UI 用来说人话：“通到 2F（+3.00m）” / “上方没有楼层，这一跑是悬空的”。
 */
export function stairTargetFloor(floors, floorId, stair) {
  const ordered = orderFloorsByElevation(floors);
  const idx = ordered.findIndex((f) => f.id === floorId);
  if (idx < 0) return null;
  const dir = stairDirection(stair);
  const next = dir === 'down' ? idx - 1 : idx + 1;
  return ordered[next] || null;
}
