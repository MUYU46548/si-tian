/**
 * 建筑在**地图上的俯视符号**（2026-11-15）。
 *
 * ## 为什么是独立模块
 *
 * `AreaMap` 的 `drawNodes` 把所有节点一视同仁画成圆点（半径 6~8px），建筑只是其中一个
 * layer 颜色。要让建筑"看得出占地与朝向"，需要的是一套**从楼层数据算出占地、再画出符号**的逻辑 ——
 * 那套逻辑跟地图视图没关系：聚落视图要用、建筑内部视图的小地图要用、以后导图也要用。
 *
 * 所以本模块只做三件事，**不认识 AreaMap、不认识 Vue、不认识相机**：
 *   1. `buildFootprint(floors)` —— 从墙算占地轮廓（cm）；
 *   2. `roofPlan(footprint, kind)` —— 俯视屋顶线（脊/檐）；
 *   3. `drawBuildingSymbol(ctx, footprint, opts)` —— 往任意 2D 画布上画（ctx 由调用方给）。
 *
 * 接入方只要在"该画建筑的地方"调一次 `drawBuildingSymbol`，其它节点一行不动。
 *
 * ## 占地怎么算：墙矩形精确并集（2026-11-15 改）
 *
 * 第一版用**墙端点的凸包**，L 形、凹字形会被填平（斜脊还会飘到轮廓外）。
 * 现在每条墙先按厚度扩成一个矩形，再对所有矩形做**多边形布尔并集**
 * （`polygon-clipping@0.15.7`，纯 default 导出 —— `import * as pc` 会拿到 `{default:{}}` 静默失效）。
 *
 * 并集同时解决了三件事：
 *   ① 凹处不再被填平（L 形就是 L 形）；
 *   ② 屋子围成一圈时自然产生**洞**（院子/中庭），大洞保留、小洞填掉；
 *   ③ 骨架不规则（斜墙、错层）也照样对 —— 精度只取决于墙数据，不取决于凸包。
 *
 * 引擎万一抛异常（退化输入）就退回凸包，不让整张地图画不出来。
 */

// 带 .js 后缀：项目里已有这个惯例（riverRender / provinceShape 都这么写），
// 好处是同一份代码既能在 Vite 里跑、也能被 Node 单测直接 import。
import polygonClipping from 'polygon-clipping';
import { convexHull, minAreaRect } from './buildShell.js';
// 异形平面的矩形拆分（2026-11-16）：每条臂一个矩形、一条标准屋脊；拆不动就退回骨架折线
import { decomposeFootprint, ridgeOfRect, hipsOfRect } from './rectDecompose.js';

/**
 * 洞占外环面积多大才当成"院子"保留（仅在 `opts.courtyard` 开启时生效）。
 *
 * 🔴 为什么默认**填掉**洞：几何上区分不了"房间内部"和"院子"——
 * 一间房四面墙围合，中间是屋顶下的空间；一个四合院四面房围合，中间是天井。两者拓扑完全一样。
 * 而建筑符号的默认语义是"这栋楼占多大地盘"，画成实心最不容易误读。
 * 想看院子就显式传 `courtyard: true`，那时只保留够大的洞（小洞是楼梯井之类，填掉）。
 */
const COURTYARD_MIN_RATIO = 0.35;

/** 多边形面积（鞋带，取绝对值） */
function ringArea(ring) {
  return Math.abs(ringArea2(ring)) / 2;
}

/** 有向面积的二倍（鞋带，带符号） */
function ringArea2(ring) {
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  return a2;
}

/** 统一成正向转序（布尔引擎对绕向敏感，随手画的墙方向不该影响结果） */
function ensurePositive(ring) {
  return ringArea2(ring) < 0 ? ring.slice().reverse() : ring.slice();
}

/** 点是否在多边形内（射线法；边界算内）——本模块不引外部几何工具，自己带一个 */
function pointInRing(pt, ring, eps = 1e-9) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    const inBox = pt.x >= Math.min(a.x, b.x) - eps && pt.x <= Math.max(a.x, b.x) + eps
      && pt.y >= Math.min(a.y, b.y) - eps && pt.y <= Math.max(a.y, b.y) + eps;
    if (Math.abs(cross) <= eps && inBox) return true;
    if (((a.y > pt.y) !== (b.y > pt.y))
      && (pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x)) {
      inside = !inside;
    }
  }
  return inside;
}

/** 一条墙 → 按厚度外扩的矩形环（4 点，[x,y]，已闭合）。太短的墙返回 null */
function wallRect(wall) {
  if (!wall || !wall.start || !wall.end) return null;
  const ax = num(wall.start.x);
  const ay = num(wall.start.y);
  const bx = num(wall.end.x);
  const by = num(wall.end.y);
  const len = Math.hypot(bx - ax, by - ay);
  if (!(len > 1)) return null;                  // 退化墙不计入
  const t = Math.max(2, num(wall.thickness, 12));
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const half = t / 2;
  // 两端各外扩半个墙厚（转角处两面墙的矩形因此重叠 → 并集连成一体）、法向 ±半个墙厚
  const p = (s, n) => [ax + ux * s - uy * n, ay + uy * s + ux * n];
  return [
    p(-half, -half),
    p(len + half, -half),
    p(len + half, half),
    p(-half, half),
    p(-half, -half),          // Ring 必须闭合
  ];
}

/**
 * 墙集合 → 精确占地（布尔并集的结果整理成 {outer, holes}）。
 *
 * @returns {null | Array<{outer:Array<{x:number,y:number}>, holes:Array<Array<{x:number,y:number}>>}>}
 */
function unionWallRects(rects, engine, opts = {}) {
  if (!rects.length) return null;
  // polygon-clipping 吃 MultiPolygon = [Polygon] = [[Ring]]，Ring 是 [[x,y],…]
  const multi = engine.union([rects[0]], ...rects.slice(1).map((r) => [r]));
  if (!Array.isArray(multi) || !multi.length) return null;
  const keepCourtyard = opts.courtyard === true;
  const out = [];
  for (const poly of multi) {
    if (!Array.isArray(poly) || !poly.length) continue;
    const toPts = (ring) => ring.slice(0, ring.length - 1).map(([x, y]) => ({ x, y }));
    const outer = toPts(poly[0]);
    if (outer.length < 3) continue;
    const outerArea = ringArea(outer);
    if (!(outerArea > 0)) continue;
    const holes = [];
    if (keepCourtyard) {
      for (let i = 1; i < poly.length; i++) {
        const h = toPts(poly[i]);
        if (h.length < 3) continue;
        // 小洞填掉（楼梯井/管道井那种），大洞当院子留着
        if (ringArea(h) / outerArea >= COURTYARD_MIN_RATIO) holes.push(h);
      }
    }
    out.push({ outer, holes });
  }
  return out.length ? out : null;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 俯视符号配色（与轴测插图同一套纸面观感，但更淡 —— 地图上不能抢地形） */
export const SYMBOL_COLORS = Object.freeze({
  roof: '#cbbba4',
  roofFlat: '#d5cfc3',
  // 多层楼的**下层屋面**（顶层面内缩后露出的那一圈腰檐）：比屋顶深一档，
  // 一眼能看出"底下还有一层"，又不至于像阴影那样把房子压黑。
  roofLower: '#b9a88f',
  roofFlatLower: '#c3bdb0',
  roofRidge: '#79695a',
  edge: '#4a4136',
  shadow: 'rgba(60, 48, 32, 0.20)',
  wallLine: '#7a6c5c',
});

/**
 * 从楼层数据算占地（**墙矩形的精确并集**）。
 *
 * @param {Array<object>} floors `[{ walls:[{start,end,thickness}], elevation, ... }]`
 * @param {{engine?:object, courtyard?:boolean}} [opts]
 *   · engine     布尔引擎（默认 polygon-clipping；测试可注入替身）
 *   · courtyard  是否保留大洞当院子（默认 false = 屋顶盖满，见 COURTYARD_MIN_RATIO 的说明）
 * @returns {null | {
 *   ring: Array<{x:number,y:number}>,          // 最大那块的外环（兼容老调用方）
 *   polygons: Array<{outer:Array, holes:Array}>,// 全部地块（不相连的楼各一块）
 *   rect: {cx,cy,u,v,halfU,halfV,long,short},   // 最小外接矩形（脊线方向靠它）
 *   area: number,                               // 外轮廓面积之和（cm²，屋顶盖住的面积）
 *   areaNet: number,                            // 扣掉院子洞之后的面积
 *   bbox: {minX,minY,maxX,maxY},
 *   floors: number, walls: number, maxWallTop: number,
 *   exact: boolean,                             // 是否走了布尔并集（false = 退回凸包）
 * }}
 *   没有任何墙返回 null（调用方按"旧色点"回落）
 */
export function buildFootprint(floors, opts = {}) {
  const list = Array.isArray(floors) ? floors : [];
  const rects = [];
  const pts = [];
  let wallCount = 0;
  let maxWallTop = 0;
  let floorCount = 0;

  for (const floor of list) {
    const walls = (floor && floor.walls) || [];
    if (walls.length) floorCount += 1;
    for (const w of walls) {
      if (!w || !w.start || !w.end) continue;
      const r = wallRect(w);
      if (!r) continue;                        // 退化墙（长度 ≤1cm）
      wallCount += 1;
      rects.push(ensurePositive(r));
      for (const [x, y] of r) pts.push({ x, y });
      maxWallTop = Math.max(maxWallTop, num(w.height, 280));
    }
  }

  if (!rects.length) return null;

  // ① 主路：精确并集。任何异常（退化输入、引擎不可用）都退回凸包，不让地图画不出来。
  let polygons = null;
  let exact = false;
  const engine = opts.engine || polygonClipping;
  try {
    polygons = unionWallRects(rects, engine, opts);
    exact = !!polygons;
  } catch (e) {
    polygons = null;
  }

  // ② 兜底：凸包（会填平凹处，但至少画得出来）
  if (!polygons) {
    const hull = convexHull(pts);
    if (!hull || hull.length < 3) return null;
    polygons = [{ outer: hull, holes: [] }];
  }

  // 最大那块当主轮廓 —— 老调用方（AreaMap 的标签定位）只看 ring
  let main = polygons[0];
  let mainArea = ringArea(main.outer);
  for (const p of polygons) {
    const a = ringArea(p.outer);
    if (a > mainArea) { main = p; mainArea = a; }
  }
  const ring = main.outer;

  // 最小外接矩形：吃凸包，不吃凹轮廓（凹点会把最小矩形带偏）
  const mr = minAreaRect(convexHull(pts)) || null;

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  let area = 0;
  let holeArea = 0;
  for (const p of polygons) {
    area += ringArea(p.outer);
    for (const h of p.holes) holeArea += ringArea(h);
  }

  // 用"中心 + 长轴单位向量 u + 短轴 v + 半长"表达外接矩形：
  // 比存一个 angle 再反复 cos/sin 可靠 —— 画布的 y 轴朝下，angle 的正负很容易搞反。
  const rect = mr
    ? {
      cx: num(mr.cx),
      cy: num(mr.cy),
      u: { x: num(mr.ux, 1), y: num(mr.uy) },
      v: { x: -num(mr.uy), y: num(mr.ux, 1) },
      // minAreaRect 的最终字段是 halfW（沿长轴）/ halfD（垂直长轴）——
      // 它内部算的是 halfU/halfV，出口前按"长轴统一"换过名，别拿错。
      halfU: num(mr.halfW),
      halfV: num(mr.halfD),
      long: num(mr.halfW) * 2,
      short: num(mr.halfD) * 2,
    }
    : {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      u: { x: 1, y: 0 },
      v: { x: 0, y: 1 },
      halfU: Math.max(1, (maxX - minX) / 2),
      halfV: Math.max(1, (maxY - minY) / 2),
      long: Math.max(1, maxX - minX),
      short: Math.max(1, maxY - minY),
    };

  return {
    ring,
    polygons,
    rect,
    area,
    areaNet: Math.max(0, area - holeArea),
    bbox: { minX, minY, maxX, maxY },
    floors: Math.max(1, floorCount),
    walls: wallCount,
    maxWallTop,
    // 走出去的是并集还是凸包兜底 —— 用例/排查要看这个，不能让"填平"静默发生
    exact,
  };
}

/**
 * 异形平面的骨架脊线（2026-11-15 改）。
 *
 * 为什么需要它：外接矩形中心线对 L 形毫无意义 ——
 * 实测 L 形 612×612 的中心线正好落在凹口那条边（y = 300）上，距离轮廓只有 6cm，
 * 符号缩到 108px 时那 1px 的偏差等于"跟轮廓重合"，看起来就是没有脊线。
 *
 * 做法：沿某个轴切若干等宽带，每一带取轮廓在该带内的另一轴范围中点，连成折线。
 * 沿长轴分带得到"横臂的脊"，沿短轴分带得到"竖臂的脊" —— L 形两臂因此各得一条。
 *
 * 🔴 **两个轴都算**：L 形的外接矩形是正方形（600×600），长轴取 x 还是 y 取决于
 * 最小外接矩形的任意解，取到 x 时折线会在横臂内部拐弯、竖臂一条线都没有。
 * 两个轴都画，谁有用谁显出来；矩形不走这条路（另有直脊 + 斜脊）。
 *
 * @returns {Array<Array<{x:number,y:number}>>} 若干段折线（每段 ≥2 点）
 */
export function skeletonRidge(polygons, rect, bandCount = 14) {
  const polys = Array.isArray(polygons) ? polygons : [];
  if (!rect || !polys.length) return [];
  // 离轮廓太近的骨架段要丢掉：L 形"重叠区"的那条中线正好压在凹口边上（只差 6cm），
  // 画出来跟轮廓重合，看着像双线。阈值按符号尺度取，不写死绝对值。
  const minGap = Math.max(8, Math.min(rect.short, rect.long) * 0.10);
  const keep = (p) => pointInFootprint(p, polys) && distToRings(p, polys) >= minGap;
  const raw = [
    ...runsAlong(polys, rect, 'u', bandCount),
    ...runsAlong(polys, rect, 'v', bandCount),
  ];
  // 过滤时还要**重新分段**：中间被丢掉点之后不能拿一条直线跨过去
  const out = [];
  for (const run of raw) {
    let cur = [];
    for (const p of run) {
      if (keep(p)) {
        cur.push(p);
      } else {
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

/** 沿 ax（'u' 长轴 / 'v' 短轴）分带，返回该方向上的骨架折线 */
function runsAlong(polys, rect, ax, bandCount) {
  const { cx, cy, u, v } = rect;
  const along = ax === 'u' ? u : v;
  const across = ax === 'u' ? v : u;
  const toS = (p) => (p.x - cx) * along.x + (p.y - cy) * along.y;
  const toT = (p) => (p.x - cx) * across.x + (p.y - cy) * across.y;
  const fromST = (s, t) => ({
    x: cx + along.x * s + across.x * t,
    y: cy + along.y * s + across.y * t,
  });

  // 🔴 必须用**边与带的交点**，不能用顶点：L 形外环只有 6 个顶点，
  //    14 条带里绝大多数一个顶点都没有 → 骨架全空。（第一版就是这么写的，测出来只剩 1 个点。）
  const edges = [];
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const poly of polys) {
    const ring = poly.outer || [];
    for (let i = 0; i < ring.length; i++) {
      const a = { s: toS(ring[i]), t: toT(ring[i]) };
      const b = { s: toS(ring[(i + 1) % ring.length]), t: toT(ring[(i + 1) % ring.length]) };
      edges.push([a, b]);
      sMin = Math.min(sMin, a.s);
      sMax = Math.max(sMax, a.s);
    }
  }
  if (!edges.length || !(sMax > sMin)) return [];

  const n = Math.max(4, Math.min(48, Math.round(bandCount)));
  const w = (sMax - sMin) / n;

  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const s0 = sMin + i * w;
    const s1 = s0 + w;
    const sc = (s0 + s1) / 2;
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const [a, b] of edges) {
      if (Math.abs(a.s - b.s) < 1e-9) {
        // 垂直于该轴的边：整条落在带内就两头都算
        if (a.s >= s0 - 1e-6 && a.s <= s1 + 1e-6) {
          tMin = Math.min(tMin, a.t, b.t);
          tMax = Math.max(tMax, a.t, b.t);
        }
      } else {
        for (const bound of [s0, s1, sc]) {
          const k = (bound - a.s) / (b.s - a.s);
          if (k < 0 || k > 1) continue;
          const t = a.t + (b.t - a.t) * k;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }
      }
    }
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax - tMin < 1e-6) { flush(); continue; }
    const mid = fromST(sc, (tMin + tMax) / 2);
    if (!pointInFootprint(mid, polys)) { flush(); continue; }
    run.push(mid);
  }
  flush();
  return runs;
}

/** 点到轮廓（外环）的最短距离 */
function distToRings(pt, polys) {
  let best = Infinity;
  for (const poly of polys) {
    const ring = poly.outer || [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      if (!(L2 > 0)) continue;
      const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2));
      const d = Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
      if (d < best) best = d;
    }
  }
  return best;
}

/** 点是否在轮廓内（不在院洞里） */
function pointInFootprint(pt, polys) {
  for (const poly of polys) {
    if (!pointInRing(pt, poly.outer, 0.001)) continue;
    let inHole = false;
    for (const h of poly.holes || []) {
      if (pointInRing(pt, h, 0.001)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * 俯视屋顶线。
 *
 * 双坡（gable）：沿长轴一条脊线（画的时候会裁剪到轮廓内）。
 * 四坡（hip）：脊线只占中间 60%，四角再连斜脊。
 * 平顶（flat）：无脊线，画内缩一圈。
 *
 * @returns {{ridge: Array<{x:number,y:number}>|null, kind:string}}
 */
export function roofPlan(footprint, kind = 'gable') {
  if (!footprint || !footprint.rect) return { ridge: null, kind };
  const { cx, cy, u, long } = footprint.rect;
  if (kind === 'flat') return { ridge: null, kind: 'flat' };
  // 双坡（gable）：脊线**贯穿**两端 —— 山墙是竖直面，正俯视只看得到矩形，看不到斜面。
  // 四坡（hip）：脊线只占中间 60%，四个角各有一条斜脊 —— 地图上更像"一栋房子"。
  const ratio = kind === 'gable' ? 1 : 0.6;
  const half = (long * ratio) / 2;
  return {
    ridge: [
      { x: cx - u.x * half, y: cy - u.y * half },
      { x: cx + u.x * half, y: cy + u.y * half },
    ],
    kind: kind === 'gable' ? 'gable' : 'hip',
  };
}

/**
 * 楼层数 → 顶层面的内缩比例（2026-11-16，屋顶随层数变化）。
 *
 * 口径：一层 = 1（不内缩，走原路径）；每多一层顶面缩 **12%**，最少到 66%。
 * 为什么是 12%（2026-11-16 第一版写 7% 被自己看图否掉）：符号在地图上按屏幕尺寸画
 * （长边 34~220px），7% 在最小档只有 2~3px —— 两层与三层**看图上分不出来**
 * （`drill_symbol_preview.py` 的层数对比图里，三层那张被读成"两层的复制品"）。
 * 12% 在 34px 档是 4px、在 108px 档是 13px：两层就看得出退台，三层与两层也能分开。
 */
export function topInsetFor(floors) {
  const n = Math.max(1, Math.round(num(floors, 1)) || 1);
  return Math.max(0.66, 1 - 0.12 * (n - 1));
}

/** footprint 的地块列表（老数据没有 `polygons` 时按单个外环处理） */
export function polygonsOf(fp) {
  if (fp && fp.polygons && fp.polygons.length) return fp.polygons;
  return [{ outer: (fp && fp.ring) || [], holes: [] }];
}

/**
 * 把占地轮廓按包围盒中心**等比内缩**（纯函数，返回同形对象，不改入参）。
 *
 * 用途：多层楼的顶层面。为什么不直接用 `ctx.scale`：那会把 `lineWidth` 一起缩掉，
 * 每处描边都得补一次补偿；而这里的绘制全是世界坐标 + `1/zoom` 线宽，几何内缩最省事、
 * 也最好测（Node 里能逐点断言）。
 */
export function insetFootprint(fp, factor) {
  if (!fp || !fp.bbox) return fp;
  const f = Math.max(0.2, Math.min(1, num(factor, 1)));
  if (f === 1) return fp;
  const cx = (fp.bbox.minX + fp.bbox.maxX) / 2;
  const cy = (fp.bbox.minY + fp.bbox.maxY) / 2;
  const sc = (ring) => (Array.isArray(ring) ? ring : [])
    .map((pt) => ({ x: cx + (pt.x - cx) * f, y: cy + (pt.y - cy) * f }));
  const polygons = polygonsOf(fp).map((p) => ({
    outer: sc(p.outer),
    holes: (p.holes || []).map(sc),
  }));
  const rect = fp.rect ? {
    ...fp.rect,
    cx: cx + (fp.rect.cx - cx) * f,
    cy: cy + (fp.rect.cy - cy) * f,
    halfU: fp.rect.halfU * f,
    halfV: fp.rect.halfV * f,
    long: fp.rect.long * f,
    short: fp.rect.short * f,
  } : fp.rect;
  const bbox = {
    minX: cx + (fp.bbox.minX - cx) * f,
    minY: cy + (fp.bbox.minY - cy) * f,
    maxX: cx + (fp.bbox.maxX - cx) * f,
    maxY: cy + (fp.bbox.maxY - cy) * f,
  };
  return {
    ...fp,
    ring: sc(fp.ring),
    polygons,
    rect,
    bbox,
    // 面积按比例平方近似（矩形/多边形在等比缩放下成立；isRect 判据只用它比值）
    area: (fp.area || 0) * f * f,
    areaNet: (fp.areaNet || 0) * f * f,
    inset: f,
  };
}

/**
 * 画建筑符号。
 *
 * 调用方负责：把 ctx 变换到**世界坐标**（跟其它地图元素同一套相机），并把 `zoom`（px per cm）传进来 ——
 * 线宽因此能保持屏幕恒定（`2 / zoom`）。不传 zoom 时按 1 处理。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} footprint `buildFootprint` 的结果
 * @param {object} [opts]
 *   · zoom      px per cm
 *   · roof      'gable' | 'flat'
 *   · selected  选中态（描边加粗、加一圈亮边）
 *   · shadow    是否画"立起来的投影"（默认 true；地图上一点点投影就能让人看出这是栋房子）
 *   · palette   配色覆盖
 */
export function drawBuildingSymbol(ctx, footprint, opts = {}) {
  if (!ctx || !footprint || !footprint.ring || footprint.ring.length < 3) return false;
  const zoom = num(opts.zoom, 1) || 1;
  // 默认四坡（hip）：地图上缩得很小时，四条斜脊是"这是栋房子"最有效的信号。
  // 双坡（gable）只画一条贯穿脊线，更像施工图而不是地图符号。
  const roof = opts.roof === 'flat' ? 'flat' : (opts.roof === 'gable' ? 'gable' : 'hip');
  const pal = { ...SYMBOL_COLORS, ...(opts.palette || {}) };
  // 多块地块（不相连的楼）+ 院子洞。老数据没有 polygons 时按单个外环处理。
  const polys = (footprint.polygons && footprint.polygons.length)
    ? footprint.polygons
    : [{ outer: footprint.ring, holes: [] }];

  const traceRing = (ring) => {
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  };
  // 所有外环 + 所有洞进同一条 path，用 evenodd 填充 → 洞自动是空的。
  // 分开 fill 的话，洞要么被后画的色块盖掉，要么得给每块单独擦除，比现在麻烦得多。
  const pathAll = () => pathOf(polys);
  const pathOf = (ps) => {
    ctx.beginPath();
    for (const p of ps) {
      traceRing(p.outer);
      for (const h of p.holes) traceRing(h);
    }
  };

  // ── 楼层数 → 屋顶长相（2026-11-16）────────────────────────────────────
  // 之前两层楼与一层楼画得**一模一样**（符号不看 `floors`）：地图上"这家是楼"读不出来。
  // 口径：**顶层面按层数内缩一圈**，外面那圈是底下那层的腰檐 —— 俯视看多层楼就是这个样子；
  // 层数越多顶越小、投影越长。**一层楼走原路径，逐像素不变**（像素基线不受影响）。
  const floors = Math.max(1, Math.round(num(opts.floors, footprint.floors || 1)) || 1);
  const topFp = floors > 1 ? insetFootprint(footprint, topInsetFor(floors)) : null;
  const topPolys = topFp ? polygonsOf(topFp) : null;
  const ridgePolys = topPolys || polys;
  const ridgeFp = topFp || footprint;

  ctx.save();

  // ① 投影：轮廓沿右下偏移，让人一眼看出"这是个有高度的东西"（不是一块地面色斑）
  if (opts.shadow !== false) {
    // 🔴 偏移量必须是**屏幕像素**换算回世界单位：第一版按"长轴 × 6%"算（最大 12cm），
    //    地图缩小时只有 2~3px 且被屋顶盖住 → 完全看不见投影，房子又变成一块平色块。
    // 投影也跟着长（高 = 更厚的影子），但**封顶 +2.8px**：再长就会越出符号、读成另一栋
    const offPx = 3.5 + (topFp ? Math.min(2.8, 1.4 * (floors - 1)) : 0);
    const off = offPx / zoom;
    ctx.save();
    ctx.translate(off, off * 1.1);
    pathAll();
    ctx.fillStyle = pal.shadow;
    ctx.fill('evenodd');
    ctx.restore();
  }

  // ② 屋顶面（洞 = 院子，不盖屋顶）
  if (topFp) {
    // 多层：先铺整块轮廓的下层屋面（深一档），顶层面再内缩压上去 —— 中间那圈就是腰檐
    pathAll();
    ctx.fillStyle = roof === 'flat' ? pal.roofFlatLower : pal.roofLower;
    ctx.fill('evenodd');
    pathOf(topPolys);
    ctx.fillStyle = roof === 'flat' ? pal.roofFlat : pal.roof;
    ctx.fill('evenodd');
  } else {
    pathAll();
    ctx.fillStyle = roof === 'flat' ? pal.roofFlat : pal.roof;
    ctx.fill('evenodd');
  }

  // ③ 轮廓（墨线）：选中时加粗并加一圈亮边
  if (topFp) {
    // 多层：外轮廓（腰檐外边）+ 顶层面内边各描一圈，中间那圈色带就是"底下一层的檐"
    pathAll();
    ctx.strokeStyle = opts.selected ? '#ffd24a' : pal.edge;
    ctx.lineWidth = (opts.selected ? 2.6 : 1.6) / zoom;
    ctx.stroke();
    pathOf(topPolys);
    ctx.stroke();
  } else {
    pathAll();
    ctx.strokeStyle = opts.selected ? '#ffd24a' : pal.edge;
    ctx.lineWidth = (opts.selected ? 2.6 : 1.6) / zoom;
    ctx.stroke();
  }
  if (opts.selected) {
    ctx.strokeStyle = 'rgba(255, 210, 74, 0.45)';
    ctx.lineWidth = 6 / zoom;
    if (topFp) pathOf(topPolys); else pathAll();
    ctx.stroke();
  }

  // ④ 屋顶线：坡顶画脊线；平顶画内缩一圈（女儿墙/防水边）
  const isRect = ridgePolys.length === 1 && ridgePolys[0].holes.length === 0
    && ridgePolys[0].outer.length === 4
    && Math.abs(ridgeFp.area - ridgeFp.rect.long * ridgeFp.rect.short)
      / Math.max(1, ridgeFp.rect.long * ridgeFp.rect.short) < 0.08;

  // 每块外环按自己包围盒的中心内缩 ratio 画一圈
  const traceInset = (ratio) => {
    ctx.beginPath();
    for (const p of ridgePolys) {
      let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
      for (const q of p.outer) {
        if (q.x < bx0) bx0 = q.x;
        if (q.x > bx1) bx1 = q.x;
        if (q.y < by0) by0 = q.y;
        if (q.y > by1) by1 = q.y;
      }
      const icx = (bx0 + bx1) / 2;
      const icy = (by0 + by1) / 2;
      for (let i = 0; i < p.outer.length; i++) {
        const px = icx + (p.outer[i].x - icx) * ratio;
        const py = icy + (p.outer[i].y - icy) * ratio;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.strokeStyle = pal.wallLine;
    ctx.lineWidth = 0.9 / zoom;
    ctx.stroke();
  };

  if (roof === 'flat') {
    traceInset(0.86);
  } else if (isRect) {
    // 矩形：一条直脊（四坡取 60%，两端留给斜脊）
    const plan = roofPlan(ridgeFp, roof === 'hip' ? 'hip' : 'gable');
    if (plan.ridge) {
      ctx.beginPath();
      ctx.moveTo(plan.ridge[0].x, plan.ridge[0].y);
      ctx.lineTo(plan.ridge[1].x, plan.ridge[1].y);
      ctx.strokeStyle = pal.roofRidge;
      ctx.lineWidth = 1.3 / zoom;
      ctx.stroke();
    }
    // 四坡：四个角连到脊线端点
    if (plan.ridge && roof === 'hip') {
      const { cx, cy, u, v, halfU, halfV } = ridgeFp.rect;
      const corners = [
        { x: cx - u.x * halfU - v.x * halfV, y: cy - u.y * halfU - v.y * halfV },
        { x: cx + u.x * halfU - v.x * halfV, y: cy + u.y * halfU - v.y * halfV },
        { x: cx + u.x * halfU + v.x * halfV, y: cy + u.y * halfU + v.y * halfV },
        { x: cx - u.x * halfU + v.x * halfV, y: cy - u.y * halfU + v.y * halfV },
      ];
      for (const end of plan.ridge) {
        const sorted = [...corners].sort((a, b) => (
          Math.hypot(a.x - end.x, a.y - end.y) - Math.hypot(b.x - end.x, b.y - end.y)
        ));
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(sorted[0].x, sorted[0].y);
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(sorted[1].x, sorted[1].y);
        ctx.strokeStyle = pal.roofRidge;
        ctx.lineWidth = 0.9 / zoom;
        ctx.stroke();
      }
    }
  } else {
    // 异形（2026-11-16，队列最后一项）：**矩形拆分** → 每条臂一条标准屋脊。
    //
    // L 形 / 凹形 / 三合院的楼是几条臂拼起来的，真实画法是每臂一条脊、交接处垂脊；
    // 以前用 `skeletonRidge` 沿轮廓分带取中点，折线会在臂里拐弯、还能跨过凹口。
    //
    // 拆不动的形状（有斜边 / 曲线墙）会自动返回空数组 —— 那种硬拆是一堆锯齿小条，
    // 比骨架更难看，所以保留骨架做回落（两条路都留了用例）。
    // 细条的阈值跟着**屏幕尺寸**走：8px 以下的块在这个符号上就是一个黑点。
    const minSideCm = Math.max(40, Math.min(260, 8 / zoom));
    const blocks = decomposeFootprint(ridgeFp, { minSideCm, maxCount: 6 });
    if (blocks.length >= 2) {
      ctx.strokeStyle = pal.roofRidge;
      for (const b of blocks) {
        const ridge = ridgeOfRect(b, roof === 'hip' ? 'hip' : 'gable');
        ctx.beginPath();
        ctx.moveTo(ridge[0].x, ridge[0].y);
        ctx.lineTo(ridge[1].x, ridge[1].y);
        ctx.lineWidth = 1.3 / zoom;
        ctx.stroke();
        if (roof !== 'hip') continue;
        // 斜脊只画到**落在外轮廓上的角**：两块共用边上的角画了就是一堆假线
        ctx.beginPath();
        for (const hip of hipsOfRect(b, ridge)) {
          if (distToRings(hip.to, ridgePolys) > 2) continue;
          ctx.moveTo(hip.from.x, hip.from.y);
          ctx.lineTo(hip.to.x, hip.to.y);
        }
        ctx.lineWidth = 0.9 / zoom;
        ctx.stroke();
      }
    } else {
      // 回落：骨架折线（外接矩形中心线对 L 形没意义，会正好压在凹口那条边上）
      const runs = skeletonRidge(ridgePolys, ridgeFp.rect);
      if (runs.length) {
        ctx.beginPath();
        for (const run of runs) {
          ctx.moveTo(run[0].x, run[0].y);
          for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
        }
        ctx.strokeStyle = pal.roofRidge;
        ctx.lineWidth = 1.3 / zoom;
        ctx.stroke();
      }
    }
  }

  ctx.restore();
  return true;
}

/**
 * 点是否落在建筑占地内（外环内、且不在保留的院洞里）。
 *
 * 给命中检测用：地图上按包围盒命中会把 L 形的凹口也算进去，点凹口会选中建筑。
 */
export function footprintContains(footprint, pt) {
  if (!footprint || !pt) return false;
  const polys = (footprint.polygons && footprint.polygons.length)
    ? footprint.polygons
    : [{ outer: footprint.ring, holes: [] }];
  for (const p of polys) {
    if (!p.outer || !pointInRing(pt, p.outer)) continue;
    let inHole = false;
    for (const h of p.holes || []) {
      if (pointInRing(pt, h)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * 符号在地图上的"应占屏幕尺寸"（压缩感）：地图缩得很小时，几百 cm 的建筑会变成一个大色块，
 * 反而压住地形。调用方可用它决定"要不要退回小圆点"。
 *
 * @returns {{w:number, h:number}} 屏幕像素
 */
export function symbolScreenSize(footprint, zoom) {
  if (!footprint || !footprint.bbox) return { w: 0, h: 0 };
  const z = num(zoom, 1) || 1;
  return {
    w: (footprint.bbox.maxX - footprint.bbox.minX) * z,
    h: (footprint.bbox.maxY - footprint.bbox.minY) * z,
  };
}
