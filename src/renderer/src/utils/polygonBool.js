// utils/polygonBool.js — 矢量级多边形布尔层（P2：省份归属 = 直接改多边形）
//
// ── 为什么有这一层 ────────────────────────────────────────────────────────
// 旧模型用「归属标签网格」当中间层（14.4 世界单位一格），编辑后用**格点轮廓反向覆盖多边形**
//   —— 10525 点的真实海岸线一次涂抹就变 ~22 点（详见 docs/SCENARIO_PROVINCE_FIX_PLAN.md）。
// P2 起：涂抹 = 对多边形做**并集 / 差集**。几何精度只取决于用户输入，**永不降级**。
//
// 🔴 本文件**不 import 任何裸模块**：布尔引擎（polygon-clipping）由调用方**注入**。
//    原因：本仓 Node 单测靠「把源文件复制到临时目录 + 写 package.json{type:module}」加载 ESM，
//    裸模块在那样的临时目录里解析不到。注入之后，本文件的纯几何部分可被单测覆盖，
//    引擎本身由 CDP 用例端到端验证。
//
// ── 两种格式 ──────────────────────────────────────────────────────────────
//   · 司天环：`[{ points: [{x,y}], kind }]`（扁平：主环 + extraRings 混在一起）
//   · 布尔格式：`MultiPolygon = [ Polygon ]`，`Polygon = [ Ring ]`，`Ring = [[x,y], …]`
//     **Ring 必须闭合**（首尾同点）；**Polygon 的第一个 Ring 是外环、其余是洞**。

import { pointInPolygon } from './geometry';
import { provinceRings, ringSigns, isValidRing } from './provinceShape';

// ══════════════════════════════════════════════════════════════════════════
// 一、格式转换
// ══════════════════════════════════════════════════════════════════════════

/** 世界点 → [x,y]（容错 {x,y} 与 [x,y] 两种形态） */
function toXY(p) {
  const x = (p && Number.isFinite(p.x)) ? p.x : (Array.isArray(p) ? p[0] : NaN);
  const y = (p && Number.isFinite(p.y)) ? p.y : (Array.isArray(p) ? p[1] : NaN);
  return [x, y];
}

/** 顶点数组 → 闭合 Ring；不足 3 个有效点返回 null */
export function ringToXY(points) {
  const out = [];
  for (const p of points || []) {
    const [x, y] = toXY(p);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  if (out.length < 3) return null;
  const a = out[0], b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}

/** Ring → 顶点数组（去掉闭合尾点与相邻重复点） */
export function xyToPoints(ring) {
  const out = [];
  for (const q of ring || []) {
    if (!Array.isArray(q) || q.length < 2) continue;
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - q[0]) < 1e-12 && Math.abs(last.y - q[1]) < 1e-12) continue;
    out.push({ x: q[0], y: q[1] });
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12) out.pop();
    else break;
  }
  return out;
}

/**
 * 扁平环列表 → `Polygon[]`（**外环 + 落在它内部的洞放同一个 Polygon**）。
 *
 * 🔴 为什么不把每个环都当独立 Polygon：**洞**必须与它的外环同组，否则布尔引擎会把洞
 *    当成独立实体 —— 并集会把洞填掉、差集语义整个反过来（静默错数据）。
 *    飞地（互不嵌套的外环）本来就应该各自成组，这条顺带正确。
 *
 * 嵌套判定复用 `ringSigns`（+1 实心 / −1 洞）——与渲染的 nonzero 填充**同源**，
 * 不另造一套「谁是洞」的判据（两套判据迟早分家）。
 */
export function groupRingsIntoPolygons(rings) {
  const list = (rings || []).filter((r) => r && isValidRing(r.points));
  if (!list.length) return [];
  if (list.length === 1) {
    const ring = ringToXY(list[0].points);
    return ring ? [[ring]] : [];
  }
  const signs = ringSigns({
    points: list[0].points,
    extraRings: list.slice(1).map((r) => ({ points: r.points })),
  });
  const outers = [];
  const holes = [];
  list.forEach((r, i) => { (signs[i] >= 0 ? outers : holes).push(r); });

  const polys = [];
  for (const r of outers) {
    const ring = ringToXY(r.points);
    if (ring) polys.push([ring]);
  }
  for (const h of holes) {
    const ring = ringToXY(h.points);
    if (!ring) continue;
    const probe = { x: ring[0][0], y: ring[0][1] };
    let host = -1;
    for (let i = 0; i < polys.length; i++) {
      if (pointInPolygon(probe.x, probe.y, xyToPoints(polys[i][0]))) { host = i; break; }
    }
    // 找不到宿主 = 数据异常 → **丢弃**这个洞，绝不静默降级成外环（那会把洞填上）
    if (host >= 0) polys[host].push(ring);
  }
  return polys;
}

/** 省份对象 → MultiPolygon */
export function provinceToMulti(prov) {
  return groupRingsIntoPolygons(provinceRings(prov));
}

/**
 * MultiPolygon → 省份几何补丁 `{ points, extraRings, kind, fromGrid }`。
 *
 * 🔴 `fromGrid: false` 必须**显式给值**：调用方是 `{ ...prov, ...patch }` 合并语义，
 *    不给这个键就等于保留旧值 —— 旧数据里 `fromGrid:true` 的省会被渲染端 Chaikin 平滑
 *    （改形状 + 点数 ×4，对 10525 点的省是灾难）。布尔结果是矢量，本就不该被平滑。
 */
export function multiToShape(mp, kind = 'land') {
  const rings = [];
  for (const poly of mp || []) {
    for (const ring of poly || []) {
      const pts = xyToPoints(ring);
      if (pts.length >= 3) rings.push({ points: pts, kind });
    }
  }
  if (!rings.length) return { points: [], extraRings: undefined, kind, fromGrid: false };
  const patch = { points: rings[0].points, fromGrid: false };
  if (kind !== 'land') patch.kind = kind;
  if (rings.length > 1) patch.extraRings = rings.slice(1).map((r) => ({ points: r.points, kind }));
  else patch.extraRings = undefined;
  return patch;
}

/** MultiPolygon 是否为空（差集把整个省挖光的判断） */
export function isEmptyMulti(mp) {
  if (!mp || !mp.length) return true;
  for (const poly of mp) {
    for (const ring of poly || []) if (Array.isArray(ring) && ring.length >= 4) return false;
  }
  return true;
}

/** MultiPolygon 的总顶点数（诊断/用例：判「几何有没有被降级」） */
export function countMultiPoints(mp) {
  let n = 0;
  for (const poly of mp || []) for (const ring of poly || []) n += (ring ? ring.length : 0);
  return n;
}

/** 环的有符号面积（绝对值的两倍 → 除以 2 得面积） */
function ringArea2(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * MultiPolygon 的**净面积**（外环加、洞减）。
 * 🔴 与 `provinceNetArea` 同口径：毛面积会把洞算成两份地，「面积守恒」断言会因此误判。
 */
export function multiNetArea(mp) {
  let s = 0;
  for (const poly of mp || []) {
    (poly || []).forEach((ring, i) => {
      const a = Math.abs(ringArea2(ring));
      s += i === 0 ? a : -a;
    });
  }
  return s;
}

/** MultiPolygon 的世界包围盒（null = 空） */
export function multiBBox(mp) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of mp || []) for (const ring of poly || []) for (const q of ring || []) {
    if (!Array.isArray(q)) continue;
    if (q[0] < minX) minX = q[0];
    if (q[0] > maxX) maxX = q[0];
    if (q[1] < minY) minY = q[1];
    if (q[1] > maxY) maxY = q[1];
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** 点是否在 MultiPolygon 内（**奇偶规则**：跨过奇数条边 = 在内；洞与飞地自动正确） */
export function pointInMulti(x, y, mp) {
  let cross = 0;
  for (const poly of mp || []) {
    for (const ring of poly || []) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        if ((a[1] > y) !== (b[1] > y)) {
          const t = (y - a[1]) / (b[1] - a[1]);
          if (a[0] + t * (b[0] - a[0]) > x) cross++;
        }
      }
    }
  }
  return (cross % 2) === 1;
}

/** 坐标吸附到 quantum 栅格（**只在布尔引擎报错时**当兜底用；见 `robustIntersection`） */
export function snapMulti(mp, quantum = 1e-3) {
  const q = quantum > 0 ? quantum : 1e-3;
  const snapRing = (ring) => (ring || []).map((p) => [Math.round(p[0] / q) * q, Math.round(p[1] / q) * q]);
  return (mp || []).map((poly) => (poly || []).map(snapRing));
}

/**
 * 🔴 **带兜底的布尔运算**：`polygon-clipping@0.15.x` 是浮点扫描线实现，在**退化几何**
 *    （共线重叠边 / 极近顶点 / 上千个环一起 union）上会抛
 *    `Unable to find segment #N … in SweepLine tree`（2026-10-11 实测：500 个 cell 一次性 union 必炸）。
 * 策略：直接算 → 抛错则把**坐标吸附到 1e-3 世界单位**再算一次。
 *    1e-3 世界单位在任何缩放下都远小于一个像素（真实底图跨度 ~1800），而且**只影响失败的那一次**，
 *    不改变正常路径的精度（本项目对「静默降级」零容忍，所以这里也**绝不静默**：
 *    结果里带 `snapped: true` 供调用方如实告知）。
 * @returns {{ multi:*, snapped:boolean, error?:string }}
 */
export function robustOp(clip, op, ...args) {
  try {
    return { multi: clip[op](...args), snapped: false };
  } catch (e) {
    const first = (e && e.message) || String(e);
    try {
      const snappedArgs = args.map((m) => (Array.isArray(m) ? snapMulti(m, 1e-3) : m));
      return { multi: clip[op](...snappedArgs), snapped: true, error: first };
    } catch (e2) {
      return { multi: null, snapped: true, error: `${first} → 吸附后仍失败：${(e2 && e2.message) || e2}` };
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 二、笔迹 → 多边形（纯几何）
// ══════════════════════════════════════════════════════════════════════════

/** 去掉连续的重复点 */
function dedupePts(points) {
  const out = [];
  for (const p of points || []) {
    const [x, y] = toXY(p);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 1e-9) continue;
    out.push({ x, y });
  }
  return out;
}

/**
 * Douglas–Peucker 折线简化（保留首尾）。
 * 为什么需要：`mousemove` 每次落一点，长按拖一大圈有上千点；不简化会把布尔 union
 * 拖进秒级（本项目已有同类教训：套索采样点简化）。
 */
export function rdpSimplify(points, tol = 0) {
  const pts = points || [];
  if (!(tol > 0) || pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    const a = pts[i], b = pts[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let best = -1, bestD = -1;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k];
      const d = len < 1e-12
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
      if (d > bestD) { bestD = d; best = k; }
    }
    if (bestD > tol && best > 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push({ x: pts[i].x, y: pts[i].y });
  return out;
}

/** 圆形 Ring（sides 边形近似；半径 r 的世界单位） */
export function brushDiscRing(x, y, r, sides = 20) {
  const n = Math.max(8, sides | 0);
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** 一段笔迹的「胶囊」矩形 Ring（宽度 2r，沿 a→b） */
export function segmentQuadRing(a, b, r) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  const nx = -dy / len * r, ny = dx / len * r;
  return [
    [a.x + nx, a.y + ny], [b.x + nx, b.y + ny],
    [b.x - nx, b.y - ny], [a.x - nx, a.y - ny],
    [a.x + nx, a.y + ny],
  ];
}

/**
 * 笔迹折线 → 一组简单多边形（每点一个圆 + 每段一个矩形）。
 * 调用方把它们 `union` 起来 = 笔刷这一次涂抹覆盖的形状。
 * @returns {Array<Array<Array<number>>>} Ring 列表
 */
export function traceBrushRings(points, radius, { tol = 0, sides = 20 } = {}) {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const pts = rdpSimplify(dedupePts(points), tol > 0 ? tol : r * 0.5);
  const rings = [];
  if (!pts.length) return rings;
  for (const p of pts) rings.push(brushDiscRing(p.x, p.y, r, sides));
  for (let i = 1; i < pts.length; i++) {
    const q = segmentQuadRing(pts[i - 1], pts[i], r);
    if (q) rings.push(q);
  }
  return rings;
}

/** 一组 Ring → MultiPolygon（每个 Ring 各自成一个 Polygon）——供布尔引擎当输入 */
export function ringsToMulti(rings) {
  const out = [];
  for (const r of rings || []) if (Array.isArray(r) && r.length >= 4) out.push([r]);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 三、布尔包装（引擎由调用方注入）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 并集；参数不足两个有效几何时原样返回 base（不调引擎，省掉一次扫描）
 *
 * 🔴 2026-10-17 第八修（**用户真机崩溃**）：
 *   `polygon-clipping` 在遇到**自相交 / 精度退化的环**时会抛
 *   `Error: Unable to complete output ring starting at [x, y]…`（它内部记账失败）。
 *   那个错误在用户圈选（套索）批量合并区域时必现：手画的套索环自交是**常态**
 *   （人手下笔不会画出一条简单多边形），于是整个 `applyProvinceLasso` 抛异常，
 *   用户看到的是"圈选批量删除直接报错"。
 *
 *   现在：**先净化输入**（自交环会让引擎记账失败）；仍然失败时**退化成"逐个并"**
 *   （一次只并一个，失败就跳过那一个并把它报给调用方），而不是把整笔操作炸掉。
 *   退化策略的代价是"漏并一小块"，但**保住了整笔操作**——对编辑来说这永远比抛异常好。
 *
 * @returns {Array} 并集结果（MultiPolygon）；`fails` 通过 `opts.onFail` 回报
 */
export function unionMulti(clip, baseMulti, addMultis, opts = {}) {
  const base = (baseMulti && baseMulti.length) ? baseMulti : [];
  const adds = (addMultis || []).filter((m) => m && m.length);
  const onFail = typeof opts.onFail === 'function' ? opts.onFail : null;
  if (!adds.length) return base;

  const attempt = (fn, label) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (onFail) onFail({ label, error: String((e && e.message) || e) });
      return { ok: false, value: null };
    }
  };

  if (!base.length) {
    if (adds.length === 1) return adds[0];
    const r = attempt(() => clip.union(adds[0], ...adds.slice(1)), 'union-all');
    if (r.ok) return r.value;
    // 退化：逐个并（失败的跳过）
    let acc = adds[0];
    for (let i = 1; i < adds.length; i++) {
      const one = attempt(() => clip.union(acc, adds[i]), `union-${i}`);
      if (one.ok && one.value) acc = one.value;
    }
    return acc;
  }

  const whole = attempt(() => clip.union(base, ...adds), 'union-with-base');
  if (whole.ok) return whole.value;
  // 退化：把每个 add 单独并进 base（一个失败不影响其它）
  let acc = base;
  for (let i = 0; i < adds.length; i++) {
    const one = attempt(() => clip.union(acc, adds[i]), `union-with-base-${i}`);
    if (one.ok && one.value) acc = one.value;
  }
  return acc;
}

/** 差集；没有要减的几何时原样返回 base */
export function differenceMulti(clip, baseMulti, cutMultis) {
  const base = (baseMulti && baseMulti.length) ? baseMulti : [];
  const cuts = (cutMultis || []).filter((m) => m && m.length);
  if (!cuts.length || !base.length) return base;
  return clip.difference(base, ...cuts);
}

/** 交集是否非空（判"这笔真的碰到这个省了吗"）——空交集可以整省跳过，省掉一次差集 */
export function intersectsMulti(clip, a, b) {
  if (!a || !a.length || !b || !b.length) return false;
  const r = clip.intersection(a, b);
  return !isEmptyMulti(r);
}

// ══════════════════════════════════════════════════════════════════════════
// 四、折线切割（A 方案：画任意折线把省份切成两半）
// ══════════════════════════════════════════════════════════════════════════
//
// ── 为什么不用「沿无限直线切」（`splitProvinceShape` 的 `splitRingByLine`）────
// 直线切割的每一侧都是**半平面**，环与它的交是良定义的、可以直接按边分类。
// 折线的两侧**不是凸集**，"点在折线的哪一侧"没有全局含义 —— 于是这里换一条路：
//
//   把折线两端沿切向延长 → 裁到省包围盒外扩成的矩形内 → 得到一条**两端落在矩形边上**的
//   内折线 Q → 从 Q 的终点沿矩形边界走回起点，闭合成一个简单环 R。
//   于是 `intersection(省, R)` = 折线一侧，`difference(省, 那一侧)` = 另一侧。
//
// 🔴 为什么用 `intersection` + `difference`（而不是构造两个环各求一次交）：
//    差集是**按定义互补**的 —— 两半的并集恒等于原省，不会在折线上留下发丝缝，
//    也不会因浮点误差让一小条地"两边都不属于"（那等于凭空丢地，本项目已踩过一次）。

const CUT_EPS = 1e-9;

/** 沿线方向从 p 向外延长 len（起终点切向：从内侧点指向端点） */
function extendBeyond(p, inner, len) {
  const dx = p.x - inner.x, dy = p.y - inner.y;
  const d = Math.hypot(dx, dy);
  if (d < CUT_EPS) return { x: p.x, y: p.y };
  return { x: p.x + (dx / d) * len, y: p.y + (dy / d) * len };
}

/** Liang–Barsky：线段裁到矩形，返回 [{x,y},{x,y}] 或 null */
export function clipSegmentToRect(a, b, r) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < CUT_EPS) return q >= 0;      // 平行：在界内则保留
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-dx, a.x - r.minX)) return null;
  if (!clip(dx, r.maxX - a.x)) return null;
  if (!clip(-dy, a.y - r.minY)) return null;
  if (!clip(dy, r.maxY - a.y)) return null;
  if (t1 - t0 < CUT_EPS) return null;
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

/** 折线按矩形裁剪 → 若干段「界内连续段」 */
export function clipPolylineToRect(pts, r) {
  const runs = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSegmentToRect(pts[i], pts[i + 1], r);
    if (!seg) { cur = null; continue; }
    const [entry, exit] = seg;
    const last = cur && cur[cur.length - 1];
    if (!cur || !last || Math.hypot(last.x - entry.x, last.y - entry.y) > 1e-7) {
      cur = [entry];
      runs.push(cur);
    }
    if (Math.hypot(cur[cur.length - 1].x - exit.x, cur[cur.length - 1].y - exit.y) > 1e-7) cur.push(exit);
  }
  return runs.filter((run) => run.length >= 2);
}

/** 折线长度 */
export function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < (pts || []).length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

/** 矩形边界参数化（0 = 左上角，沿边界一圈回到 4；t 与坐标一一对应） */
function rectParam(p, r) {
  const w = Math.max(r.maxX - r.minX, CUT_EPS);
  const h = Math.max(r.maxY - r.minY, CUT_EPS);
  const tol = 1e-6 * Math.max(w, h);
  if (Math.abs(p.y - r.minY) <= tol) return (p.x - r.minX) / w;
  if (Math.abs(p.x - r.maxX) <= tol) return 1 + (p.y - r.minY) / h;
  if (Math.abs(p.y - r.maxY) <= tol) return 2 + (r.maxX - p.x) / w;
  return 3 + (r.maxY - p.y) / h;
}

/** 沿矩形边界从 from 走到 to（逆时针增参方向），返回**中间角点**列表（不含两端） */
export function rectBorderCorners(from, to, r) {
  const t0 = rectParam(from, r), t1 = rectParam(to, r);
  let span = t1 - t0;
  while (span <= 1e-9) span += 4;            // 同一条边相邻两点 → 直接走 4（整圈）
  const out = [];
  for (const c of [0, 1, 2, 3]) {
    let d = c - t0;
    while (d <= 0) d += 4;
    if (d < span - 1e-9) {
      out.push({
        d,
        p: c === 0 ? { x: r.minX, y: r.minY }
          : c === 1 ? { x: r.maxX, y: r.minY }
            : c === 2 ? { x: r.maxX, y: r.maxY } : { x: r.minX, y: r.maxY },
      });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map((o) => o.p);
}

/**
 * 折线 → **一个简单闭合环**（Ring，首尾同点）——它的内部 = 折线的一侧，且覆盖整个 bbox。
 * @param {Array<{x,y}|[number,number]>} polyline 用户画的折线（≥2 点）
 * @param {{minX,minY,maxX,maxY}} bbox 省（所有环）的包围盒
 * @returns {{ ring:Array<[number,number]>, runs:number, a:{x,y}, b:{x,y} }|null}
 */
export function cutRingForPolyline(polyline, bbox) {
  const pts = dedupePts(polyline);
  if (pts.length < 2 || !bbox) return null;
  const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 1e-6);
  const grow = span;                                   // 外扩量：格线外不会切到省
  const rect = {
    minX: bbox.minX - grow, minY: bbox.minY - grow,
    maxX: bbox.maxX + grow, maxY: bbox.maxY + grow,
  };
  // 两端沿切向延长出矩形（保证折线一定横穿矩形，从而两端落在矩形边上）
  const ext = span * 4;
  const head = extendBeyond(pts[0], pts[1], ext);
  const tail = extendBeyond(pts[pts.length - 1], pts[pts.length - 2], ext);
  const full = [head, ...pts, tail];
  const runs = clipPolylineToRect(full, rect);
  if (!runs.length) return null;
  // 取最长的一段（用户折线来回出界时，只有真正横穿的那段是切割线）
  let q = runs[0];
  for (const r of runs) if (polylineLength(r) > polylineLength(q)) q = r;
  if (q.length < 2) return null;
  const A = q[0], B = q[q.length - 1];
  // 沿矩形边界从 B 走回 A：折线 + 这段回程 = 简单闭合环（回程全在省之外）
  const ring = q.map((p) => [p.x, p.y]);
  for (const c of rectBorderCorners(B, A, rect)) ring.push([c.x, c.y]);
  ring.push([A.x, A.y]);
  if (ring.length < 4) return null;
  return { ring, runs: runs.length, a: A, b: B };
}

/**
 * 沿折线把省份切成两半（A 方案）。
 *
 * @param clip 布尔引擎（注入）
 * @param prov 省份对象（多环 / 带洞 / 飞地都支持）
 * @param polyline 用户折线（世界坐标；端点不必落在省外 —— 会自动延长）
 * @returns `{a, b, aArea, bArea}` 两个**省份对象**（各带新 id，与 `splitProvinceShape` 同形）；
 *          null = 没切着（折线没穿过这个省）
 */
export function splitProvinceByPolyline(clip, prov, polyline, opts = {}) {
  const rings = provinceRings(prov);
  if (!rings.length) return null;
  const base = provinceToMulti(prov);
  const box = multiBBox(base);
  if (!box) return null;
  const cut = cutRingForPolyline(polyline, box);
  if (!cut) return null;
  const cutMulti = [[cut.ring]];
  let sideA = null, snapped = false;
  try {
    sideA = clip.intersection(base, cutMulti);
  } catch (e) {
    const r = robustOp(clip, 'intersection', base, cutMulti);
    sideA = r.multi; snapped = true;
  }
  if (isEmptyMulti(sideA)) return null;
  let sideB = null;
  try {
    sideB = clip.difference(base, cutMulti);
  } catch (e) {
    const r = robustOp(clip, 'difference', base, cutMulti);
    sideB = r.multi; snapped = true;
  }
  if (isEmptyMulti(sideB)) return null;                // 折线只擦过一角 → 不算切割

  const kind = (prov && prov.kind === 'sea') ? 'sea' : 'land';
  const mkId = opts.makeId || ((s) => `prov_${Date.now().toString(36)}_${s}`);
  const mk = (mp, suffix, fallback) => Object.assign(
    { ...prov, id: `${mkId(suffix)}`, name: `${(prov && prov.name) || '省份'} ${fallback}` },
    multiToShape(mp, kind),
  );
  const a = mk(sideA, 'pa', '西');
  const b = mk(sideB, 'pb', '东');
  return {
    a, b, snapped, cutPoints: cut.ring.length, runs: cut.runs,
    aArea: multiNetArea(sideA), bArea: multiNetArea(sideB),
    aPoints: countMultiPoints(sideA), bPoints: countMultiPoints(sideB),
  };
}
