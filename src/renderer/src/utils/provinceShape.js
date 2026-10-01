// utils/provinceShape.js — 省份几何的「唯一表示」纯函数层（P0 第二块）
//
// 解决的问题（用户侧三条投诉「丑东西 / 圈不着 / 功能打架」的数据层根因）：
//   ① **单环模型**：省份只能有一个 `points` 环 → 飞地、多块领土、带洞的行政区表达不了，
//      合并只能退化成「凸包」（实测吃掉邻居省份）；海域（sea）与陆地（land）也无处标注。
//   ② **无共享边界**：手绘描点的省份彼此不共享顶点 → 相邻省之间必然留缝。
//   ③ **几何无单一来源**：网格（`provinceLabels`）与多边形（`terrain[].points`）两套各自演化。
//
// ── 表示法（唯一事实源，见下）────────────────────────────────────────────────
// 存储形态**保持向后兼容**：主环仍是 `p.points`（既有 30+ 处消费者、既有用例、
// FMG 导入、贝塞尔控制点全都读它），额外环放 `p.extraRings: [{points, kind}]`，
// 省份级 `p.kind: 'land' | 'sea'`（**只有岛/海才需要写**，默认 land）。
// 本模块的 `provinceRings(p)` 返回 `[{points, kind}, …]` 就是「多环实体」的规范视图，
// 每个环在磁盘上只有一处描述 —— 两个字段之间没有任何冗余副本，因此不存在漂移。
//
// 为什么不把 `points` 改名成 `rings[0].points`：那会让「描边」与「笔刷」产出两份几何语义，
// 且序列化时要么重复一份坐标、要么在序列化器里特例剥字段（隐式约定最易腐坏）。
// skill §88/§112 的红线是「同一功能不要两套数据模型」——本模块遵守的是那条红线，
// 不是字段名。
//
// ── 纯函数 ────────────────────────────────────────────────────────────────
// 本文件不碰 store / DOM / 响应式（离屏光栅化也只用 TypedArray + gridOutline 的纯实现），
// 所以 Node 侧能直接 require（scripts/tests/unit/test_province_shape.js）。

import { signedArea, pointInPolygon } from './geometry';
import { buildLabelOutlines } from './gridOutline';

export const RING_KIND_LAND = 'land';
export const RING_KIND_SEA = 'sea';

const normKind = (k) => (k === RING_KIND_SEA ? RING_KIND_SEA : RING_KIND_LAND);
const px = (p) => (p && Number.isFinite(p.x) ? p.x : (p && Number.isFinite(p[0]) ? p[0] : NaN));
const py = (p) => (p && Number.isFinite(p.y) ? p.y : (p && Number.isFinite(p[1]) ? p[1] : NaN));
const validPt = (p) => Number.isFinite(px(p)) && Number.isFinite(py(p));

/** 顶点数组是否够成一个环 */
export function isValidRing(points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let n = 0;
  for (const p of points) if (validPt(p)) n++;
  return n >= 3;
}

// ══════════════════════════════════════════════════════════════════════════
// 一、多环视图 + 无损归一化（迁移）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 省份 → 环列表 `[{points, kind}]`（规范视图；永不返回 null）。
 * 主环 = `p.points`（kind 取省份级 `p.kind`），其余来自 `p.extraRings`。
 * @returns {Array<{points:Array, kind:string}>}
 */
export function provinceRings(prov) {
  if (!prov || typeof prov !== 'object') return [];
  const baseKind = normKind(prov.kind);
  const out = [];
  // `fromGrid`：该环是否由「归属格轮廓」派生 —— 渲染端只有它需要平滑（消格点台阶），
  // 手绘 / 描点 / 贝塞尔环一律原样（顶点是用户刻意摆的）。主环的标记落在**省份级**字段
  // （`points` 是裸数组，挂不上环级标记），额外环各带各的。
  if (isValidRing(prov.points)) out.push({ points: prov.points, kind: baseKind, fromGrid: !!prov.fromGrid });
  const extra = prov.extraRings;
  if (Array.isArray(extra)) {
    for (const r of extra) {
      if (!r) continue;
      const pts = Array.isArray(r) ? r : r.points;
      if (!isValidRing(pts)) continue;
      out.push({ points: pts, kind: normKind(r.kind || baseKind), fromGrid: !!(r && r.fromGrid) });
    }
  }
  return out;
}

/** 只取顶点数组（绘制/命中/包围盒用） */
export function provinceRingPoints(prov) {
  return provinceRings(prov).map((r) => r.points);
}

export function ringCount(prov) {
  return provinceRings(prov).length;
}

export function isMultiRing(prov) {
  return ringCount(prov) > 1;
}

/** 省份是否含海域环 */
export function hasSeaRing(prov) {
  return provinceRings(prov).some((r) => r.kind === RING_KIND_SEA);
}

/**
 * 无损迁移 / 归一化（**幂等**）：
 *   · 补齐 `kind`（默认 land）
 *   · `extraRings` 里无 `points` 的条目转成 `{points, kind}`
 *   · 丢掉退化环（< 3 点 / 非法坐标）—— 与 `provinceRings` 的可见性保持一致
 *   · 主环 `points` **一个字节都不动**（含 controlIn/controlOut 等附加字段）
 * 无变化时原样返回入参（避免每次调用都产生新对象 → 触发响应式/全量重绘）。
 * @returns {object} 归一化后的省份（可能是同一个引用）
 */
export function normalizeProvince(prov) {
  if (!prov || typeof prov !== 'object') return prov;
  let changed = false;
  const out = { ...prov };

  if (out.kind === undefined) { out.kind = RING_KIND_LAND; changed = true; }
  else if (normKind(out.kind) !== out.kind) { out.kind = normKind(out.kind); changed = true; }
  // fromGrid 只做「真值归一」（省得存 0/1/'true' 这类脏值）；不主动删除，它是渲染口径的一部分
  if (out.fromGrid !== undefined && typeof out.fromGrid !== 'boolean') {
    out.fromGrid = !!out.fromGrid; changed = true;
  }

  const extra = Array.isArray(prov.extraRings) ? prov.extraRings : null;
  if (extra) {
    const kept = [];
    for (const r of extra) {
      const pts = Array.isArray(r) ? r : (r && r.points);
      if (!isValidRing(pts)) { changed = true; continue; }
      const wasBare = Array.isArray(r);
      const kind = normKind(r && r.kind ? r.kind : out.kind);   // 额外环缺 kind 时继承省份级
      if (wasBare || (r && r.kind !== kind)) changed = true;
      kept.push({ points: pts, kind });
    }
    if (kept.length !== extra.length) changed = true;
    if (!kept.length) { delete out.extraRings; changed = true; }
    else out.extraRings = kept;
  }
  return changed ? out : prov;
}

/**
 * 整张省份表归一化。
 * @returns {{ terrain:Array, changed:number }} changed = 需要写回的省份个数
 */
export function normalizeTerrain(terrain) {
  if (!Array.isArray(terrain)) return { terrain: [], changed: 0 };
  let changed = 0;
  const out = terrain.map((p) => {
    const n = normalizeProvince(p);
    if (n !== p) changed++;
    return n;
  });
  return { terrain: changed ? out : terrain, changed };
}

/** 用环列表构造省份的几何字段（返回可 `Object.assign` 的补丁） */
export function shapePatch(rings) {
  const list = (rings || []).filter((r) => isValidRing(r && r.points));
  if (!list.length) return { points: [], extraRings: undefined };
  const kind = normKind(list[0].kind);
  const patch = { points: list[0].points };
  if (kind !== RING_KIND_LAND) patch.kind = kind; else delete patch.kind;
  // 主环的「网格派生」标记必须落到**省份级**字段（points 是裸数组）；必须显式给值 ——
  // 调用方是 `{ ...prov, ...patch }` 合并语义：不给这个键就等于保留旧值（手工改过的环会被误平滑）
  patch.fromGrid = !!list[0].fromGrid;
  if (list.length > 1) {
    patch.extraRings = list.slice(1).map((r) => (
      r.fromGrid ? { points: r.points, kind: r.kind, fromGrid: true } : { points: r.points, kind: r.kind }
    ));
  } else patch.extraRings = undefined;
  return patch;
}

// ══════════════════════════════════════════════════════════════════════════
// 二、度量与命中（与渲染的 evenodd 填充保持同一语义）
// ══════════════════════════════════════════════════════════════════════════

export function provinceBBox(prov) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of provinceRingPoints(prov)) {
    for (const p of pts) {
      const x = px(p), y = py(p);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 毛面积（各环面积绝对值之和，世界单位²）。
 * 用途是**面积闸门**（挡住「一点就把整片海填了」），不是精确的拓扑面积 ——
 * 环是洞还是飞地在这里不区分，闸门只关心量级。
 */
export function provinceArea(prov) {
  let a = 0;
  for (const pts of provinceRingPoints(prov)) a += Math.abs(signedArea(pts));   // signedArea 已是面积，勿再 /2
  return a;
}

/**
 * 省份的**净面积**（洞减掉、飞地加上）= 用户眼里「这块地有多大」。
 *
 * 🔴 与 `provinceArea`（各环绝对值之和）的区别：带洞的省份 gross 会把洞的面积也算进去
 *    （100×100 外框 + 20×20 洞 → gross 10400、net 10000）。凡是「面积守恒 / 面积比较」的
 *    断言与显示都必须用 net，否则一出现洞就把洞算成两份地。
 */
export function provinceNetArea(prov) {
  const rings = provinceRings(prov);
  if (!rings.length) return 0;
  const signs = ringSigns(prov);
  let a = 0;
  for (let i = 0; i < rings.length; i++) a += (signs[i] || 1) * Math.abs(signedArea(rings[i].points));
  return a;
}

/**
 * 环的**嵌套符号**（+1 = 实心外环 / -1 = 洞）。
 *
 * 🔴 为什么必须有它：多环省份有两种完全不同的语义 ——
 *    · 「飞地 / 不连通的领土」= 两个互不嵌套的外环（都该填）
 *    · 「洞」= 落在另一个环内部的环（不该填）
 *    偶数嵌套深度 = 实心，奇数 = 洞。涂色产出的环（gridOutline 按「左手侧 = 本格」取向）
 *    天然满足这条；合并/写回时也必须把绕向统一到这条不变式上，否则渲染（nonzero 填充）
 *    会把洞填掉、或把飞地挖空。
 */
export function ringSigns(prov) {
  const rings = provinceRings(prov);
  return rings.map((r, i) => {
    const pts = r.points;
    // 🔴 用**环自己的顶点**判嵌套，不能用质心：外环的质心可能正好落在它的洞里面
    //    （实测 100×100 外框 + 中心 20×20 洞 → 质心 (50,50) 在洞里 → 外环被误判成洞，
    //    整个省份翻面）。取多个顶点的**最小**嵌套数：外环总有顶点在洞外。
    const samples = [];
    const step = Math.max(1, Math.floor(pts.length / 8));
    for (let k = 0; k < pts.length && samples.length < 8; k += step) samples.push(pts[k]);
    if (!samples.length) return 1;
    let depth = Infinity;
    for (const s of samples) {
      if (!validPt(s)) continue;
      let d = 0;
      for (let j = 0; j < rings.length; j++) {
        if (i === j) continue;
        if (pointInPolygon(px(s), py(s), rings[j].points)) d++;
      }
      if (d < depth) depth = d;
    }
    if (!Number.isFinite(depth)) return 1;
    return depth % 2 === 0 ? 1 : -1;
  });
}

/**
 * 取向后的环列表：`{points, kind, sign}`，`points` 的绕向已与 `sign` 一致
 * （signedArea 的符号 × sign ≥ 0）。渲染（nonzero）与布尔运算都以此为准。
 */
export function orientedRings(prov) {
  const rings = provinceRings(prov);
  const signs = ringSigns(prov);
  return rings.map((r, i) => {
    const s = signs[i];
    const pos = signedArea(r.points) >= 0 ? 1 : -1;
    return { points: pos === s ? r.points : r.points.slice().reverse(), kind: r.kind, sign: s };
  });
}

/**
 * nonzero 命中（绕数 ≠ 0）：与 canvas 的 `fill()`（默认 nonzero）完全一致 —— 所见即所点。
 * 飞地（同向双环）会命中，洞（反向环）不会。
 */
export function pointInProvince(x, y, prov) {
  const rings = provinceRings(prov);
  const signs = ringSigns(prov);
  let w = 0;
  for (let i = 0; i < rings.length; i++) {
    if (pointInPolygon(x, y, rings[i].points)) w += signs[i];
  }
  return w !== 0;
}

// ══════════════════════════════════════════════════════════════════════════
// 三、环清理 / 简化（渲染前处理，带缓存）
// ══════════════════════════════════════════════════════════════════════════

/** 去掉相邻重复点与收尾重合点 */
export function dedupeRing(points) {
  const out = [];
  for (const p of points || []) {
    if (!validPt(p)) continue;
    const q = { x: px(p), y: py(p) };
    for (const k of ['controlIn', 'controlOut']) if (p && p[k]) q[k] = p[k];
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - q.x, last.y - q.y) < 1e-9) continue;
    out.push(q);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) out.pop();
    else break;
  }
  return out;
}

/** 去共线中间点（网格轮廓的阶梯边界会因此塌成斜线，点数通常降到 1/3 以下） */
export function collapseCollinearXY(points) {
  const pts = points || [];
  const n = pts.length;
  if (n < 4) return pts.map((p) => ({ ...p }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const s1x = Math.sign(px(b) - px(a)), s1y = Math.sign(py(b) - py(a));
    const s2x = Math.sign(px(c) - px(b)), s2y = Math.sign(py(c) - py(b));
    if (s1x === s2x && s1y === s2y) continue;
    out.push({ ...b });
  }
  return out.length >= 3 ? out : pts.map((p) => ({ ...p }));
}

/** Chaikin 圆角（闭合环），返回普通 `{x,y}` 数组 */
export function chaikinRing(points, iters = 2) {
  let pts = (points || []).map((p) => [px(p), py(p)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3 || iters <= 0) return pts.map(([x, y]) => ({ x, y }));
  for (let it = 0; it < iters; it++) {
    const out = new Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out[i * 2] = [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25];
      out[i * 2 + 1] = [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75];
    }
    pts = out;
  }
  return pts.map(([x, y]) => ({ x, y }));
}

// 🔴 平滑几何必须缓存：Chaikin 2 轮会把点数 ×4，21 省 × 数千点逐帧算就是「拖不动」。
//    缓存键用**顶点数组本身**（WeakMap）：编辑一律换新数组 → 自动失效、自动 GC。
const smoothCache = new WeakMap();
export function smoothRing(points, iters = 2) {
  if (!Array.isArray(points) || !points.length) return [];
  const key = iters;
  let byIters = smoothCache.get(points);
  if (byIters && byIters[key]) return byIters[key];
  const out = chaikinRing(collapseCollinearXY(dedupeRing(points)), iters);
  if (!byIters) { byIters = {}; smoothCache.set(points, byIters); }
  byIters[key] = out;
  return out;
}

/** 省份 → 每个环的平滑顶点（渲染直接可用） */
export function smoothProvinceRings(prov, iters = 2) {
  return provinceRings(prov).map((r) => smoothRing(r.points, iters));
}

/**
 * 环的**渲染顶点**：该环怎么画，全应用只有一个判定（画布、PNG 导出、SVG 导出、标签落点共用）。
 *
 * · **网格派生的环**（`fromGrid`，由归属格轮廓重算出来的）→ Chaikin 平滑，消掉格点台阶
 *   （这正是「马赛克 / 台阶边」的收敛点；网格只作为中间层，落库的是平滑后的折线）。
 * · **手绘 / 描点 / 带贝塞尔控制点的环** → 原样（顶点是用户刻意摆的，平滑会削掉有意的形状）。
 *
 * 2026-10-01 从 `ScenarioMap.vue` 移到这里：SVG 导出当时直接画 `prov.points`，
 * 于是"涂抹改过的省"在导出图里台阶感更重 —— 同一件事两份实现 = 改一处另一处不变。
 */
export function ringPointsForRender(ring) {
  if (!ring || !Array.isArray(ring.points)) return null;
  if (!ring.fromGrid) return ring.points;
  for (const q of ring.points) if (q && (q.controlOut || q.controlIn)) return ring.points;
  return smoothRing(ring.points, 2);
}

// ══════════════════════════════════════════════════════════════════════════
// 四、分割（侧符号分类）
// ══════════════════════════════════════════════════════════════════════════

function centroidOf(points) {
  let x = 0, y = 0, n = 0;
  for (const p of points) { if (!validPt(p)) continue; x += px(p); y += py(p); n++; }
  return n ? { x: x / n, y: y / n } : null;
}

/** 沿无限直线求环的两个半环；直线不过环 → null */
function splitRingByLine(points, a, b) {
  const src = dedupeRing(points);
  const n = src.length;
  if (n < 4) return null;
  const side = src.map((p) => {
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    return cross >= 0 ? 1 : -1;
  });
  const pos = [], neg = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (side[i] >= 0) pos.push(src[i]); else neg.push(src[i]);
    if (side[i] !== side[j]) {
      const denom = (src[j].x - src[i].x) * (a.y - b.y) - (src[j].y - src[i].y) * (a.x - b.x);
      if (Math.abs(denom) > 1e-12) {
        const t = ((a.x - src[i].x) * (a.y - b.y) - (a.y - src[i].y) * (a.x - b.x)) / denom;
        if (t >= -1e-9 && t <= 1 + 1e-9) {
          const ip = { x: src[i].x + t * (src[j].x - src[i].x), y: src[i].y + t * (src[j].y - src[i].y) };
          pos.push(ip);
          neg.push(ip);
        }
      }
    }
  }
  const A = dedupeRing(pos), B = dedupeRing(neg);
  if (A.length < 3 && B.length < 3) return null;
  return { pos: A.length >= 3 ? A : null, neg: B.length >= 3 ? B : null };
}

/**
 * 省份沿切割线拆成两个（**保留多环与 land/sea**）。
 * 每个环独立切割后按侧归并：一个环若没被切到，整环归到质心所在的一侧。
 * @returns {{a:object, b:object}|null} null = 切割无效（线没穿过多边形 / 每侧不足 3 点）
 */
let splitSeq = 0;   // 同一毫秒内连拆多次也要拿到不同 id（否则 id 撞车 → 后续按 id 找省找错人）

export function splitProvinceShape(prov, p1, p2, opts = {}) {
  if (!prov || !p1 || !p2) return null;
  const mkId = opts.makeId || ((s) => `prov_${Date.now().toString(36)}_${s}${++splitSeq}`);
  const rings = provinceRings(prov);
  if (!rings.length) return null;

  const sideOf = (p) => (((p2.x - p1.x) * (p.y - p1.y) - (p2.y - p1.y) * (p.x - p1.x)) >= 0 ? 'pos' : 'neg');
  const acc = { pos: [], neg: [] };
  let anyCut = false;

  for (const r of rings) {
    const cut = splitRingByLine(r.points, p1, p2);
    if (cut) {
      anyCut = true;
      if (cut.pos) acc.pos.push({ points: cut.pos, kind: r.kind });
      if (cut.neg) acc.neg.push({ points: cut.neg, kind: r.kind });
    } else {
      const c = centroidOf(r.points) || { x: 0, y: 0 };
      acc[sideOf(c)].push({ points: r.points, kind: r.kind });
    }
  }
  if (!anyCut) return null;
  if (!acc.pos.length || !acc.neg.length) return null;

  const base = { ...prov };
  delete base.extraRings;
  return {
    a: Object.assign({ ...base, id: `${mkId('a')}`, name: `${prov.name || '省份'} A` }, shapePatch(acc.pos)),
    b: Object.assign({ ...base, id: `${mkId('b')}`, name: `${prov.name || '省份'} B` }, shapePatch(acc.neg)),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 五、合并（共边抵消 = 精确并集；退化时才退回栅格并集）
// ══════════════════════════════════════════════════════════════════════════

const QKEY = (x, y, q) => `${Math.round(x / q)}:${Math.round(y / q)}`;

/**
 * 把每条边在「落在它身上的其他顶点」处切开（T 形接点 / 共线部分重叠）。
 *
 * 🔴 为什么少不了这一步：两个省共边时，**边长往往不相等** —— 比如 A 的南边界是
 *    `(20,10)→(0,10)`（一条长边），B 的北边界是 `(0,10)→(10,10)`（半条）。
 *    单纯按「整边反向重合」抵消时它们谁也不匹配 → 并集退化成两个环（等于没合并）。
 *    真实数据里这种情况**必然出现**：写回环时会做共线塌缩，长边会把中间的节点吃掉。
 *    切开之后两条边变成同样的两段，抵消才成立。
 * @returns {Array<{a,b,ka,kb,used}>}
 */
function splitEdgesAtNodes(edges, quantum) {
  const nodes = new Map();
  for (const e of edges) {
    nodes.set(e.ka, { x: e.a.x, y: e.a.y });
    nodes.set(e.kb, { x: e.b.x, y: e.b.y });
  }
  const nodeList = [];
  for (const [k, n] of nodes) nodeList.push({ k, x: n.x, y: n.y });

  const out = [];
  for (const e of edges) {
    const ax = e.a.x, ay = e.a.y, bx = e.b.x, by = e.b.y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) continue;
    const minX = Math.min(ax, bx) - quantum, maxX = Math.max(ax, bx) + quantum;
    const minY = Math.min(ay, by) - quantum, maxY = Math.max(ay, by) + quantum;
    const hits = [];
    for (const n of nodeList) {
      if (n.k === e.ka || n.k === e.kb) continue;
      if (n.x < minX || n.x > maxX || n.y < minY || n.y > maxY) continue;
      const t = ((n.x - ax) * dx + (n.y - ay) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      const cx = ax + t * dx, cy = ay + t * dy;
      if ((cx - n.x) * (cx - n.x) + (cy - n.y) * (cy - n.y) > quantum * quantum) continue;
      hits.push({ t, k: n.k, x: n.x, y: n.y });
    }
    if (!hits.length) { out.push({ a: e.a, b: e.b, ka: e.ka, kb: e.kb, used: false }); continue; }
    hits.sort((p, q) => p.t - q.t);
    let prevK = e.ka, prevX = ax, prevY = ay;
    for (const h of hits) {
      out.push({ a: { x: prevX, y: prevY }, b: { x: h.x, y: h.y }, ka: prevK, kb: h.k, used: false });
      prevK = h.k; prevX = h.x; prevY = h.y;
    }
    out.push({ a: { x: prevX, y: prevY }, b: { x: bx, y: by }, ka: prevK, kb: e.kb, used: false });
  }
  return out;
}

/**
 * 有向边抵消法求并集（**精确**，不做任何量化近似 —— 顶点只做 key 比较）：
 *   ① 各环统一绕向（signedArea ≥ 0）
 *   ② 每条边在落在其上的其他顶点处切开（T 接点 / 共线部分重叠，见 splitEdgesAtNodes）
 *   ③ 成对反向重合的边（共边）互相抵消
 *   ④ 剩下的边按「最右转」走链 → 闭合环（正确保留洞与飞地）
 * 由网格派生的省份彼此共边**完全重合**（同一套格边），FMG 导入的相邻州也共用同一批
 * Voronoi 顶点 → 这条路径覆盖绝大多数真实数据。
 * @returns {Array<Array<{x:number,y:number}>>} 环列表（可能多个 = 多环/飞地，也可能为空）
 */
export function unionRingsByCancellation(rings, { quantum = 1e-6, minArea = 1e-9, maxWork = 2e7, stats = null } = {}) {
  const edges = [];
  for (const r of rings || []) {
    const pts = dedupeRing((r && r.points) || r);
    if (pts.length < 3) continue;
    // 绕向**不再归一**：调用方必须传取向一致的环（`orientedRings` —— 外环正、洞负）。
    // 归一化会把「洞」翻成「实心」并集，是静默的语义错误。相邻两省的共边本就是反向的，
    // 所以只要各方绕向自洽，抵消就成立。
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      edges.push({ a, b, ka: QKEY(a.x, a.y, quantum), kb: QKEY(b.x, b.y, quantum), used: false });
    }
  }
  if (!edges.length) { if (stats) Object.assign(stats, { edges: 0, nodes: 0, work: 0, maxWork, overflow: false }); return []; }

  const nodeCount = new Set();
  for (const e of edges) { nodeCount.add(e.ka); nodeCount.add(e.kb); }
  const work = edges.length * nodeCount.size;
  // 把量纲交回调用方（`mergeProvinceShapes` 要把它写进返回值，UI 才能说「超阈 N 倍」而不是一句"降级"）
  if (stats) Object.assign(stats, { edges: edges.length, nodes: nodeCount.size, work, maxWork, overflow: work > maxWork });
  if (work > maxWork) return [];                       // 规模过大 → 交给栅格兜底（调用方会看到空数组）
  const split = work > edges.length ? splitEdgesAtNodes(edges, quantum) : edges;

  const byKey = new Map();
  split.forEach((e, i) => {
    const k = e.ka + '>' + e.kb;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  for (let i = 0; i < split.length; i++) {
    const e = split[i];
    if (e.used) continue;
    const bucket = byKey.get(e.kb + '>' + e.ka);
    if (!bucket) continue;
    const j = bucket.find((x) => !split[x].used);
    if (j === undefined) continue;
    e.used = true;
    split[j].used = true;
  }

  const live = split.filter((e) => !e.used);
  if (!live.length) return [];

  const start = new Map();          // 起点 key → 出边下标（live 内）
  live.forEach((e, i) => {
    if (!start.has(e.ka)) start.set(e.ka, []);
    start.get(e.ka).push(i);
  });
  const ang = (fx, fy, tx, ty) => Math.atan2(ty - fy, tx - fx);
  // 最右转：进来时朝向 back = 起点方向，选「顺时针转过的角最小」的出边 → 贴着边界走
  const pickNext = (fromNodeKey, nodeKey, node) => {
    const list = start.get(nodeKey);
    if (!list) return -1;
    const back = ang(node.x, node.y, fromX, fromY);
    let best = -1, bestDelta = Infinity;
    for (const i of list) {
      const e = live[i];
      if (e.used) continue;
      let delta = back - ang(node.x, node.y, e.b.x, e.b.y);
      while (delta <= 1e-12) delta += Math.PI * 2;
      if (delta < bestDelta - 1e-12) { bestDelta = delta; best = i; }
    }
    return best;
  };
  let fromX = 0, fromY = 0;

  const loops = [];
  for (let s = 0; s < live.length; s++) {
    if (live[s].used) continue;
    live[s].used = true;
    const first = live[s].ka;
    const loop = [{ x: live[s].a.x, y: live[s].a.y }];
    let cur = live[s];
    const cap = live.length + 4;
    let guard = 0;
    while (guard++ < cap) {
      const to = cur.kb;
      loop.push({ x: cur.b.x, y: cur.b.y });
      if (to === first) break;
      const node = cur.b;
      fromX = cur.a.x; fromY = cur.a.y;
      const nxt = pickNext(cur.ka, to, node);
      if (nxt < 0) { loop.length = 0; break; }
      live[nxt].used = true;
      cur = live[nxt];
    }
    if (loop.length < 4) continue;
    loop.pop();                                   // 收尾点 = 起点，去掉
    const cleaned = collapseCollinearXY(loop);
    if (cleaned.length >= 3 && Math.abs(signedArea(cleaned)) > minArea) loops.push(cleaned);
  }
  return loops;
}

/**
 * 两个环是否「真正穿过」（严格相交：不含端点接触 / 共边 / 包含）。
 * 🔴 不能用 `detectSelfIntersection(A.concat(B))`：把两个环接成一条折线本身就会造出
 *    两段「桥接边」，它们与自己的环相交 → 恒为真（实测：一个环 + 它内部的洞被判成「穿插」，
 *    合并于是无谓地退回栅格，面积还量化错了）。必须逐边两两严格相交 + 包围盒预筛。
 */
export function ringsProperlyCross(a, b) {
  const A = dedupeRing(a), B = dedupeRing(b);
  if (A.length < 3 || B.length < 3) return false;
  const cross = (o, p, q) => (q.x - o.x) * (p.y - o.y) - (p.x - o.x) * (q.y - o.y);
  const bb = (pts) => {
    let l = Infinity, t = Infinity, r = -Infinity, bo = -Infinity;
    for (const p of pts) { if (p.x < l) l = p.x; if (p.x > r) r = p.x; if (p.y < t) t = p.y; if (p.y > bo) bo = p.y; }
    return { l, t, r, bo };
  };
  const ba = bb(A), bbb = bb(B);
  if (ba.r < bbb.l || bbb.r < ba.l || ba.bo < bbb.t || bbb.bo < ba.t) return false;

  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    const la = Math.min(a1.x, a2.x), ra = Math.max(a1.x, a2.x);
    const ta = Math.min(a1.y, a2.y), oa = Math.max(a1.y, a2.y);
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j], b2 = B[(j + 1) % B.length];
      if (Math.max(b1.x, b2.x) < la || Math.min(b1.x, b2.x) > ra) continue;
      if (Math.max(b1.y, b2.y) < ta || Math.min(b1.y, b2.y) > oa) continue;
      const d1 = cross(b1, b2, a1), d2 = cross(b1, b2, a2);
      if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))) continue;
      const d3 = cross(a1, a2, b1), d4 = cross(a1, a2, b2);
      if ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) return true;
    }
  }
  return false;
}

/**
 * 栅格并集（退化兜底）：把环并集采样成掩膜 → 抽平滑轮廓。
 * 只在「环真的互相穿过」时使用（共边抵消对穿插无能为力）；分辨率按包围盒自适应。
 * 🔴 填掩膜走**扫描线**（每行求交点 → 填跨度），不是「逐格点对多边形求交」：
 *    后者是 O(格数 × 点数)，单省上千顶点时是秒级；扫描线是 O(行数 × 点数)，毫秒级。
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function unionRingsByRaster(rings, { maxDim = 220 } = {}) {
  const list = (rings || []).map((r) => dedupeRing((r && r.points) || r)).filter((p) => p.length >= 3);
  if (!list.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of list) for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cell = span / maxDim;
  const ox = minX - cell, oy = minY - cell;
  const cols = Math.max(2, Math.ceil((maxX - ox) / cell) + 2);
  const rows = Math.max(2, Math.ceil((maxY - oy) / cell) + 2);
  const labels = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    const cy = oy + (r + 0.5) * cell;
    for (const pts of list) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a.y > cy) === (b.y > cy)) continue;
        xs.push(a.x + (cy - a.y) / (b.y - a.y) * (b.x - a.x));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - ox) / cell - 0.5));
        const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - ox) / cell - 0.5));
        for (let c = c0; c <= c1; c++) labels[r * cols + c] = 1;
      }
    }
  }

  const outlines = buildLabelOutlines(labels, cols, rows, {
    cell, ox, oy, eps: 0.75, chaikinIters: 1, outside: 0, ignore: null, minAreaCells: 1,
  });
  const out = [];
  for (const lp of outlines.get(1) || []) out.push(lp.pts.map((p) => ({ x: p.x, y: p.y })));
  return out;
}

/**
 * 合并多个省份为**多环实体**（取代旧的「凸包合并」——凸包会把邻省的凹口一起吞掉，
 * 用户实测原话「丑东西」）。
 * @returns {{ shape:object, method:'cancel'|'raster', loops:number, work:number, edges:number,
 *            nodes:number, maxWork:number, overflow:boolean, pairsTested:number, crossScanSkipped:boolean }}
 */
export function mergeProvinceShapes(provinces, opts = {}) {
  const list = (provinces || []).filter((p) => p && provinceRings(p).length);
  if (!list.length) return null;
  const rings = [];
  for (const p of list) for (const r of orientedRings(p)) rings.push(r);   // 绕向按嵌套符号归一
  if (rings.length === 1) {
    const only = list.find((p) => provinceRings(p).some((r) => r.points === rings[0].points)) || list[0];
    const r0 = orientedRings(only)[0];
    return {
      shape: { points: r0.points, extraRings: undefined, kind: r0.kind }, method: 'cancel', loops: 1,
      work: 0, edges: 0, nodes: 0, maxWork: opts.maxWork || 2e7, overflow: false,
      pairsTested: 0, crossScanSkipped: false,
    };
  }

  // ① 先试精确共边抵消；若两环真的穿过 → 该结果不成立，退回栅格
  const cost = {};
  let loops = unionRingsByCancellation(rings, {
    maxWork: Number.isFinite(opts.maxWork) ? opts.maxWork : 2e7,
    stats: cost,
  });
  let method = 'cancel';

  // ② 相交扫描（决定要不要退回栅格）。两处省钱（2026-10-02，真实库实测的真实瓶颈）：
  //    · `work > maxWork` 时**直接跳过整轮扫描** —— 反正必走栅格，扫了也是白扫。
  //      旧实现照扫：真实库前两大省（10525 × 10071 点）≈ 1.06e8 次内层迭代 = 合并卡顿的主因。
  //    · 先过**包围盒**：bbox 不相交的两个环不可能真穿过，而 `ringsProperlyCross` 每次都
  //      重新 `dedupeRing` 两个环 —— 不相邻的省对占绝大多数，这一步几乎全免。
  const overflow = !!cost.overflow;
  let crossed = false;
  let pairsTested = 0;
  let crossScanSkipped = overflow;
  if (!overflow) {
    const boxes = rings.map((r) => bboxOfRaw(r.points));
    outer:
    for (let i = 0; i < rings.length; i++) {
      for (let j = i + 1; j < rings.length; j++) {
        if (!boxesOverlapRaw(boxes[i], boxes[j])) continue;
        pairsTested++;
        if (ringsProperlyCross(rings[i].points, rings[j].points)) { crossed = true; break outer; }
      }
    }
  }
  if (crossed || !loops.length) {
    const rl = unionRingsByRaster(rings);
    if (rl.length) { loops = rl; method = 'raster'; }
  }
  if (!loops.length) return null;

  const baseKind = rings.every((r) => r.kind === RING_KIND_SEA) ? RING_KIND_SEA : RING_KIND_LAND;
  const shaped = loops.map((pts) => ({ points: pts, kind: baseKind }));
  return {
    shape: shapePatch(shaped), method, loops: loops.length,
    work: cost.work || 0, edges: cost.edges || 0, nodes: cost.nodes || 0,
    maxWork: cost.maxWork || 0, overflow, pairsTested, crossScanSkipped,
    crossed,
  };
}

function bboxOfRaw(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points || []) {
    if (!p) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function boxesOverlapRaw(a, b) {
  if (!a || !b) return true;
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

// ══════════════════════════════════════════════════════════════════════════
// 六、共享边界骨架（吸附「整段插顶点」→ 相邻省零缝）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 全局只读边界骨架：所有既有省份的环（每环一条闭合折线）。排除 `excludeId`
 * （编辑自己时不该吸附到自己身上）。骨架**只读**，不写回任何东西。
 */
export function buildSkeleton(provinces, excludeId = null) {
  const out = [];
  for (const p of provinces || []) {
    if (!p) continue;
    if (excludeId && p.id === excludeId) continue;
    for (const r of provinceRings(p)) out.push(r.points);
  }
  return out;
}

const skeletonIndex = new WeakMap();
function indexOfLine(line, q = 1e-6) {
  let m = skeletonIndex.get(line);
  if (m) return m;
  m = new Map();
  for (let i = 0; i < line.length; i++) {
    const k = QKEY(line[i].x, line[i].y, q);
    if (!m.has(k)) m.set(k, i);
  }
  skeletonIndex.set(line, m);
  return m;
}

function arcBetween(line, ka, kb) {
  const idx = indexOfLine(line);
  const ia = idx.get(ka), ib = idx.get(kb);
  if (ia === undefined || ib === undefined || ia === ib) return null;
  const N = line.length;
  const fwd = [], bwd = [];
  for (let k = (ia + 1) % N; k !== ib; k = (k + 1) % N) fwd.push(line[k]);
  for (let k = (ib + 1) % N; k !== ia; k = (k + 1) % N) bwd.push(line[k]);
  const len = (arc) => {
    let L = 0, prev = line[ia];
    for (const p of arc) { L += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
    L += Math.hypot(line[ib].x - prev.x, line[ib].y - prev.y);
    return L;
  };
  return len(fwd) <= len(bwd) ? fwd : bwd;
}

/**
 * 把手绘/描点的轮廓「贴」到既有边界骨架上：
 *   ① 顶点落在骨架顶点 threshold 内 → 直接换成骨架顶点（坐标完全相同 → 零缝）
 *   ② 相邻两个「已吸附」顶点之间 → 沿骨架**整段插入**中间顶点（这是「圈不着」的正解：
 *      只吸端点会在两省之间斜切一条缝，整段插顶点才是沿同一条线走）
 * 插入前提：沿骨架那段弧长 ≤ 弦长 × maxDetour（默认 1.6）—— 否则说明用户在绕远路，
 * 不该被拉过去（避免把有意的形状吸成骨架弧）。
 * @returns {Array<{x:number,y:number}>} 处理后的顶点（可能与入参等长，也可能更长）
 */
export function conformToSkeleton(points, skeleton, threshold = 10, { maxDetour = 1.6 } = {}) {
  const src = dedupeRing(points);
  if (src.length < 3 || !skeleton || !skeleton.length) return src;

  const snapped = src.map((p) => {
    let best = null, bd = threshold;
    for (const line of skeleton) {
      for (const v of line) {
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best ? { x: best.x, y: best.y, hit: true } : { x: p.x, y: p.y, hit: false };
  });

  const out = [];
  for (let i = 0; i < snapped.length; i++) {
    const a = snapped[i], b = snapped[(i + 1) % snapped.length];
    out.push({ x: a.x, y: a.y });
    if (!a.hit || !b.hit) continue;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord <= threshold) continue;                   // 太短，插了也没意义
    const ka = QKEY(a.x, a.y, 1e-6), kb = QKEY(b.x, b.y, 1e-6);
    let bestArc = null, bestLen = Infinity;
    for (const line of skeleton) {
      const arc = arcBetween(line, ka, kb);
      if (!arc || !arc.length) continue;
      let L = 0, prev = { x: a.x, y: a.y };
      for (const p of arc) { L += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
      L += Math.hypot(b.x - prev.x, b.y - prev.y);
      if (L < bestLen) { bestLen = L; bestArc = arc; }
    }
    if (bestArc && bestLen <= chord * maxDetour) out.push(...bestArc.map((p) => ({ x: p.x, y: p.y })));
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 七、点击填充（面积闸门）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 从起点泛滥同标签的连通区域（4 邻域，栈式，避免递归爆栈）。
 * @returns {Int32Array} 命中格的下标（按升序）
 */
export function floodRegion(labels, grid, c, r, { cap = 0 } = {}) {
  const { cols, rows } = grid;
  if (!labels || c < 0 || r < 0 || c >= cols || r >= rows) return new Int32Array(0);
  const target = labels[r * cols + c];
  const seen = new Uint8Array(cols * rows);
  const out = [];
  const stack = [r * cols + c];
  seen[r * cols + c] = 1;
  const limit = cap > 0 ? cap : cols * rows;
  while (stack.length) {
    const i = stack.pop();
    if (labels[i] !== target) continue;
    out.push(i);
    if (out.length > limit) return new Int32Array(0);   // 超限 = 不当使用，交给闸门拒绝
    const cc = i % cols, rr = (i - cc) / cols;
    if (cc > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
    if (cc < cols - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
    if (rr > 0 && !seen[i - cols]) { seen[i - cols] = 1; stack.push(i - cols); }
    if (rr < rows - 1 && !seen[i + cols]) { seen[i + cols] = 1; stack.push(i + cols); }
  }
  out.sort((a, b) => a - b);
  return Int32Array.from(out);
}

/** 像素格 → 世界面积（面积闸门用） */
export function cellsArea(cells, grid) {
  return (cells ? cells.length : 0) * grid.cell * grid.cell;
}

// ══════════════════════════════════════════════════════════════════════════
// 八、环 ↔ 网格轮廓互转（笔刷产出物写回多边形用）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 归属标签网格 → 每个标签的环（**原始网格轮廓**，不做 Chaikin）。
 * 为什么存原始轮廓而不是平滑后的：原始轮廓的顶点**落在格线上**，重新栅格化会得到
 * 完全相同的格集合（无漂移）；平滑后的几何再栅格化会逐轮漂移，网格与多边形会慢慢分家。
 * 平滑交给渲染期（`smoothRing`，带缓存）。
 * @returns {Map<number, Array<Array<{x:number,y:number}>>>} label → 环数组
 */
export function ringsFromLabels(labels, grid, { eps = 0.75 } = {}) {
  const outlines = buildLabelOutlines(labels, grid.cols, grid.rows, {
    cell: grid.cell, ox: grid.ox, oy: grid.oy,
    eps, chaikinIters: 0, outside: 0, ignore: [0], minAreaCells: 1,
  });
  const out = new Map();
  for (const [label, list] of outlines) out.set(label, list.map((lp) => lp.pts.map((p) => ({ x: p.x, y: p.y }))));
  return out;
}

/** 单个标签的环（只关心一个省时用，省掉整表轮廓的成本；内部仍走整表实现以保证一致性） */
export function ringsOfLabel(labels, grid, label, opts) {
  const m = ringsFromLabels(labels, grid, opts);
  return m.get(label) || [];
}

/**
 * 几何指纹（FNV-1a，坐标量化到 1/4 世界单位）。
 *
 * 用途：**判断存的归属网格是不是这套多边形派生的** —— `provinceLabels.shape` 存指纹，
 * 读取时比对，不符就按多边形重建。为什么需要它：改了多边形的调用点有十几处
 * （新增/删除/分割/合并/拖顶点/插入顶点/自由绘制/导入…），靠「每处都记得作废缓存」
 * 必然漏一处，而漏掉的后果是**静默的错数据**（拿旧几何派生的归属格去渲染/涂抹）。
 * @returns {number} 32 位无符号整数
 */
export function shapeSignature(provinces) {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= (n | 0); h = Math.imul(h, 0x01000193) >>> 0; };
  for (const p of provinces || []) {
    const rings = provinceRings(p);
    mix(rings.length);
    mix(p && p.kind === RING_KIND_SEA ? 1 : 0);
    for (const r of rings) {
      mix(r.points.length);
      mix(r.kind === RING_KIND_SEA ? 1 : 0);
      for (const q of r.points) {
        const x = Math.round(px(q) * 4), y = Math.round(py(q) * 4);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        mix(x); mix(y);
      }
    }
  }
  return h >>> 0;
}

// ══════════════════════════════════════════════════════════════════════════
// 九、多边形 → 归属网格（多环 / 带洞口径，与渲染的 nonzero 填充一致）
// ══════════════════════════════════════════════════════════════════════════

/** 由省份（多环）推导网格包围盒 */
export function gridFromProvinceShapes(provinces, makeGridFn) {
  const pts = [];
  for (const p of provinces || []) for (const r of provinceRings(p)) pts.push(...r.points);
  const bbox = (() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of pts) {
      const x = px(q), y = py(q);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  })();
  return makeGridFn(bbox);
}

/**
 * 省份表 → 归属序号网格（`0 = 无主`）。
 * **按面积降序、命中即停**：大省先落，小省不覆盖已有归属 —— 否则小多边形会在大多边形上
 * 啃出一个个洞（导入的 FMG 数据里小省多得多）。
 * 命中判据是**绕数 ≠ 0**（`orientedRings` 的符号），所以「洞」不会被填，「飞地」会被填。
 * @returns {Uint8Array}
 */
export function rasterizeProvinceShapes(provinces, grid) {
  const { cols, rows, cell, ox, oy } = grid;
  const labels = new Uint8Array(cols * rows);
  const order = (provinces || []).map((p, i) => {
    const rings = orientedRings(p);
    let area = 0;
    for (const r of rings) area += Math.abs(signedArea(r.points)) * r.sign;
    return { idx: i + 1, rings, area: Math.abs(area), bbox: provinceBBox(p) };
  }).filter((o) => o.rings.length && o.area > 0 && o.bbox).sort((a, b) => b.area - a.area);

  for (const o of order) {
    const c0 = Math.max(0, Math.floor((o.bbox.minX - ox) / cell));
    const c1 = Math.min(cols - 1, Math.floor((o.bbox.maxX - ox) / cell));
    const r0 = Math.max(0, Math.floor((o.bbox.minY - oy) / cell));
    const r1 = Math.min(rows - 1, Math.floor((o.bbox.maxY - oy) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (labels[i]) continue;
        const x = ox + (c + 0.5) * cell, y = oy + (r + 0.5) * cell;
        let w = 0;
        for (const ring of o.rings) if (pointInPolygon(x, y, ring.points)) w += ring.sign;
        if (w !== 0) labels[i] = o.idx;
      }
    }
  }
  return labels;
}
