// interior/footprint.js — 建筑占地（从墙矩形算精确并集）
//
// ## 为什么单独一个文件（2026-11-16）
//
// 占地这件事原来在 `buildingSymbol.js` 里。现在 **3D 屋顶**也要它：异形平面（L / U / 凹形）
// 在 3D 里要按矩形拆分逐块起坡（见 `buildShell.js` 的屋顶段），而拆分的输入就是这份轮廓。
// 如果继续留在 buildingSymbol 里，`buildShell → buildingSymbol → buildShell` 就是个循环 import
// （那两个文件互相要用对方的东西）。抽到这一层之后依赖是单向的：
//   `buildingSymbol / footprintField / settlement / buildShell  →  footprint  →  polyGeom`
//
// ## 占地怎么算：墙矩形精确并集
//
// 每条墙先按厚度外扩成一个矩形，再对所有矩形做**多边形布尔并集**
// （`polygon-clipping@0.15.7`，纯 default 导出 —— `import * as pc` 会拿到 `{default:{}}` 静默失效）。
//
// 并集同时解决了三件事：
//   ① 凹处不被填平（L 形就是 L 形）；
//   ② 屋子围成一圈时自然产生**洞**（院子/中庭），大洞保留、小洞填掉；
//   ③ 骨架不规则（斜墙、错层）也照样对 —— 精度只取决于墙数据，不取决于凸包。
//
// 引擎万一抛异常（退化输入）就退回凸包，不让整张地图画不出来。

import polygonClipping from 'polygon-clipping';
import { convexHull, minAreaRect } from './polyGeom.js';

/**
 * 洞占外环面积多大才当成"院子"保留（仅在 `opts.courtyard` 开启时生效）。
 *
 * 🔴 为什么默认**填掉**洞：几何上区分不了"房间内部"和"院子"——
 * 一间房四面墙围合，中间是屋顶下的空间；一个四合院四面房围合，中间是天井。两者拓扑完全一样。
 * 而建筑符号的默认语义是"这栋楼占多大地盘"，画成实心最不容易误读。
 */
export const COURTYARD_MIN_RATIO = 0.35;

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

/** footprint 的地块列表（老数据没有 `polygons` 时按单个外环处理） */
export function polygonsOf(fp) {
  if (fp && fp.polygons && fp.polygons.length) return fp.polygons;
  return [{ outer: (fp && fp.ring) || [], holes: [] }];
}

export { pointInRing };
