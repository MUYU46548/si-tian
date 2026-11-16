/**
 * interior/settlement.js —— 聚落鸟瞰（2026-11-16）
 *
 * ## 这一层回答什么
 *
 * 单栋轴测插图回答“这栋楼长什么样”；**聚落鸟瞰**回答“这个镇子长什么样”：
 * 同一套几何（`buildShell`）、同一套平涂墨线，把区域里所有建筑按地图位置摆开，
 * 再把道路铺成浅色带，出一张 3600×2400 的镇子插图。
 *
 * ## 三条口径（每条都会影响“这图对不对”）
 *
 * 1) **地图单位 = 米**（与区域地图左上角那根标尺同一口径：标尺写 `x m` / `x km`）。
 *    建筑内部的世界单位是 cm，所以摆位时 ×100 —— 换算只有一处实现（`MAP_UNIT_CM`），
 *    别在别处再乘一次。
 * 2) **没画内部的建筑照样画**：地图上一栋楼常常只有一个点。给它一块体块
 *    （有 `node.footprint` 就用它的尺寸，没有就 8×6 m），颜色浅一档；
 *    图注里写明“N 栋有内部图 / M 栋只有体块”—— 不许假装它有墙。
 * 3) **纯函数**：不 import three、不碰 DOM、不用随机数。渲染在 `axoScene`。
 *
 * ## 为什么道路要自己算成多边形
 *
 * 一条路是一串点 + 一个宽度。如果按段各画一个盒子，每个拐点都会多出一条横线
 * （像被切成几截）；按**折线偏移成一条带**（miter 接头）再描一圈外轮廓，
 * 路面才是连续的。见 `roadRibbon`。
 */

import { buildFootprint } from './buildingSymbol.js';
import { northScreenVector, northText } from './axoProps.js';

/** 1 个地图单位 = 多少 cm（地图单位 = 米） */
export const MAP_UNIT_CM = 100;

export const SETTLEMENT_DEFAULTS = Object.freeze({
  plainWidth: 800,      // 没有内部图、也没有 footprint 字段时，体块按 8m 宽
  plainDepth: 600,
  plainHeight: 320,     // 一层平房的高度（体块，不是真屋顶）
  roadWidth: 300,       // 村道 3m
  pad: 400,             // 取景外扩（cm）：4m 的余量够放影子，再多就把镇子缩没了
});

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 取数值：null / 空串 / NaN 都算“没给”，回落到默认（`Number(null) === 0` 是这里最容易踩的坑） */
function numOr(v, d) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 多边形有向面积（>0 = 逆时针） */
function signedArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function normBoundsOf(a) {
  if (!a) return null;
  const min = Array.isArray(a.min) ? a.min.map((v) => num(v)) : null;
  const max = Array.isArray(a.max) ? a.max.map((v) => num(v)) : null;
  if (!min || !max) return null;
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

// ── 道路：折线 → 一条带 ─────────────────────────────────────────────────

/** 两个点的单位方向；重合返回 null */
function dirOf(a, b) {
  const dx = num(b.x) - num(a.x);
  const dy = num(b.y) - num(a.y);
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  return { x: dx / len, y: dy / len };
}

/**
 * 折线 → 路面多边形（带宽）+ 左右两条边。
 *
 * 接头用 miter（角平分线方向、按 `1/cos(半角)` 拉长），并把拉长量**夹到 3 倍半宽** ——
 * 急转弯（尤其 180° 折返）不夹的话会甩出一根几十米长的尖角，比不画还难看。
 * 180° 折返（前后方向相反）退化成用前一段的法向，路面会自己叠回去（能接受）。
 *
 * @param {Array<{x:number,y:number}>} points 折线（cm）
 * @param {number} widthCm 路面宽
 * @returns {null | {poly:Array<{x:number,y:number}>, left:Array, right:Array, widthCm:number, lengthCm:number}}
 */
export function roadRibbon(points, widthCm = SETTLEMENT_DEFAULTS.roadWidth) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => ({ x: num(p.x), y: num(p.y) }));
  if (pts.length < 2) return null;
  const hw = Math.max(10, num(widthCm, SETTLEMENT_DEFAULTS.roadWidth) / 2);

  const left = [];
  const right = [];
  let lengthCm = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const d1 = i > 0 ? dirOf(pts[i - 1], p) : null;
    const d2 = i < pts.length - 1 ? dirOf(p, pts[i + 1]) : null;
    if (d1) lengthCm += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    const n1 = d1 ? { x: -d1.y, y: d1.x } : null;
    const n2 = d2 ? { x: -d2.y, y: d2.x } : null;
    let n = null;
    if (n1 && n2) {
      const bx = n1.x + n2.x;
      const by = n1.y + n2.y;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-6) {
        n = n1;                       // 180° 折返：用前一段的法向
      } else {
        const ux = bx / bl;
        const uy = by / bl;
        const cos = ux * n1.x + uy * n1.y;   // = cos(半角)
        const k = Math.min(3, cos > 1e-3 ? 1 / cos : 3);
        n = { x: ux * k, y: uy * k };
      }
    } else {
      n = n1 || n2;
    }
    left.push({ x: round2(p.x + n.x * hw), y: round2(p.y + n.y * hw) });
    right.push({ x: round2(p.x - n.x * hw), y: round2(p.y - n.y * hw) });
  }
  const poly = left.concat(right.slice().reverse());
  // 🔴 统一成**逆时针**：三角形的法向随之朝上。顺指针的话面朝下 →
  //    three 的 FrontSide 把它们整个剔掉，画面上只剩两条边线（第一版就是这么"只有线没有面"的）。
  if (signedArea(poly) < 0) poly.reverse();
  return {
    poly,
    left,
    right,
    widthCm: hw * 2,
    lengthCm: Math.round(lengthCm),
  };
}

// ── 采集：区域里有什么 ───────────────────────────────────────────────────

/**
 * 把一个区域的子节点 + 道路变成“要画的东西”。
 *
 * @param {object} input
 * @param {Array} [input.places] 区域子节点（只要 `layer === 'building'` 且有坐标）
 * @param {Array} [input.routes] 区域道路 `[{ id, name, points:[{x,y}], color }]`
 * @param {object} [input.interiorData] `interiorData[buildingId]`
 * @param {object} [input.opts] { mapUnitCm, roadWidth, plainWidth, plainDepth, plainHeight }
 * @returns {{buildings:Array, roads:Array, stats:object}}
 */
export function collectSettlement(input = {}) {
  const opts = input.opts || {};
  const unit = num(opts.mapUnitCm, MAP_UNIT_CM);
  const roadWidth = num(opts.roadWidth, SETTLEMENT_DEFAULTS.roadWidth);
  const interiorData = input.interiorData || {};
  const places = Array.isArray(input.places) ? input.places : [];

  const buildings = [];
  for (const node of places) {
    if (!node || node.layer !== 'building') continue;
    const cx = num(node.coordinate && node.coordinate.x);
    const cy = num(node.coordinate && node.coordinate.y);
    // 地图原点就是世界原点：坐标 (x, y) 米 → 世界 (x*100, 0, y*100) cm
    const atX = cx * unit;
    const atZ = cy * unit;

    const data = interiorData[node.id];
    const floors = data && Array.isArray(data.floors) ? data.floors.filter(Boolean) : [];
    let fp = null;
    if (floors.length) {
      try { fp = buildFootprint(floors); } catch (e) { fp = null; }
      if (!fp || !fp.bbox) fp = null;
    }

    if (fp) {
      // 有内部图：把占地的中心平移到节点位置（与地图上的符号同一个规矩）
      const ccx = (fp.bbox.minX + fp.bbox.maxX) / 2;
      const ccy = (fp.bbox.minY + fp.bbox.maxY) / 2;
      buildings.push({
        id: String(node.id),
        name: String(node.name || ''),
        wired: true,
        floors,
        offset: [round2(atX - ccx), 0, round2(atZ - ccy)],
        at: [round2(atX), 0, round2(atZ)],
        widthCm: round2(fp.bbox.maxX - fp.bbox.minX),
        depthCm: round2(fp.bbox.maxY - fp.bbox.minY),
        rooms: Array.isArray(node.rooms) ? node.rooms.length : 0,
      });
      continue;
    }

    // 没有内部图：一块体块。尺寸优先用节点上的 footprint 字段（A21），否则按默认
    const field = node.footprint && typeof node.footprint === 'object' ? node.footprint : null;
    // ⚠️ 别写 `num(field && field.w, 默认)`：field 为空时那是 `num(null, 800)`，
    // 而 Number(null) === 0 → 房子被压成 120cm。缺值要显式判。
    const w = Math.max(120, numOr(field && field.w, num(opts.plainWidth, SETTLEMENT_DEFAULTS.plainWidth)));
    const d = Math.max(120, numOr(field && field.h, num(opts.plainDepth, SETTLEMENT_DEFAULTS.plainDepth)));
    buildings.push({
      id: String(node.id),
      name: String(node.name || ''),
      wired: false,
      floors: [],
      offset: [0, 0, 0],
      at: [round2(atX), 0, round2(atZ)],
      widthCm: round2(w),
      depthCm: round2(d),
      heightCm: Math.max(80, num(opts.plainHeight, SETTLEMENT_DEFAULTS.plainHeight)),
      rooms: 0,
    });
  }

  const roads = [];
  for (const route of Array.isArray(input.routes) ? input.routes : []) {
    if (!route || !Array.isArray(route.points) || route.points.length < 2) continue;
    const pts = route.points
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .map((p) => ({ x: num(p.x) * unit, y: num(p.y) * unit }));
    if (pts.length < 2) continue;
    const ribbon = roadRibbon(pts, num(route.width, roadWidth));
    if (!ribbon) continue;
    roads.push({
      id: String(route.id || `road-${roads.length + 1}`),
      name: String(route.name || ''),
      color: route.color || '',
      dashed: route.dashed === true,
      ...ribbon,
    });
  }

  const wired = buildings.filter((b) => b.wired).length;
  return {
    buildings,
    roads,
    stats: {
      buildings: buildings.length,
      wired,
      plain: buildings.length - wired,
      roads: roads.length,
      roadLengthCm: roads.reduce((sum, r) => sum + num(r.lengthCm), 0),
    },
  };
}

/**
 * 没画内部的建筑 → 一个体块外壳。
 *
 * 形状故意做成与 `buildShell()` 的返回值**同构**（boxes/surfaces/roof/bounds/stats），
 * 渲染层就不用为“这栋有没有内部图”写分支 —— 两条路走同一段代码，观感才一致。
 *
 * @param {object} building `collectSettlement` 给的一项（`wired === false`）
 * @param {object} [opts] { color }
 */
export function plainShell(building, opts = {}) {
  const b = building || {};
  const at = Array.isArray(b.at) ? b.at : [0, 0, 0];
  const w = Math.max(120, num(b.widthCm, SETTLEMENT_DEFAULTS.plainWidth));
  const d = Math.max(120, num(b.depthCm, SETTLEMENT_DEFAULTS.plainDepth));
  const h = Math.max(80, num(b.heightCm, SETTLEMENT_DEFAULTS.plainHeight));
  const box = {
    kind: 'wall',
    color: opts.color || '#cfc7b8',
    cx: num(at[0]),
    cy: h / 2,
    cz: num(at[2]),
    sx: w,
    sy: h,
    sz: d,
    rotY: 0,
  };
  const min = [box.cx - w / 2, 0, box.cz - d / 2];
  const max = [box.cx + w / 2, h, box.cz + d / 2];
  return {
    boxes: [box],
    surfaces: [],
    roof: null,
    empty: false,
    bounds: {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    },
    stats: { floors: 1, walls: 0, openings: 0, boxes: 1, plain: true },
  };
}

// ── 取景包围盒：楼 + 路一起 ───────────────────────────────────────────────

/**
 * 整片聚落的包围盒。
 *
 * @param {Array<{bounds:object, offset:number[]}>} items 每栋楼（`bounds` = buildShell 的、
 *   `offset` = `collectSettlement` 给的那一份）
 * @param {Array<{poly:Array<{x:number,y:number}>}>} roads
 * @param {number} [padCm] 四周外扩
 * @returns {null | {min:number[], max:number[], size:number[], center:number[]}}
 */
export function settlementBounds(items, roads, padCm = 0) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const eat = (x, y, z) => {
    min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
  };
  let any = false;
  for (const it of Array.isArray(items) ? items : []) {
    const b = normBoundsOf(it && it.bounds);
    if (!b) continue;
    const o = Array.isArray(it.offset) ? it.offset : [0, 0, 0];
    for (const x of [b.min[0], b.max[0]]) {
      for (const y of [b.min[1], b.max[1]]) {
        for (const z of [b.min[2], b.max[2]]) {
          eat(x + num(o[0]), y + num(o[1]), z + num(o[2]));
          any = true;
        }
      }
    }
  }
  for (const r of Array.isArray(roads) ? roads : []) {
    for (const p of (r && r.poly) || []) {
      eat(num(p.x), 0, num(p.y));
      any = true;
    }
  }
  if (!any) return null;
  const pad = num(padCm, 0);
  if (pad !== 0) {
    min[0] -= pad; min[2] -= pad;
    max[0] += pad; max[2] += pad;
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

// ── 比例尺（聚落尺度的“人”就是尺子）────────────────────────────────────

/**
 * 比例尺：正交投影下，沿屏幕右轴走 1 cm 世界 = `renderWidth / spanW` 像素，所以
 * 尺子的长度是**精确**的（不是估的）。取一个整米/整公里的长度，让它落在目标像素附近。
 *
 * @param {{spanWCm:number, renderWidthPx:number, targetPx?:number}} input
 * @returns {{cm:number, px:number, label:string}}
 */
export function settlementScaleBar(input = {}) {
  const spanW = Math.max(1, num(input.spanWCm, 1));
  const renderW = Math.max(1, num(input.renderWidthPx, 1));
  const pxPerCm = renderW / spanW;
  const target = Math.max(40, num(input.targetPx, Math.round(renderW * 0.12)));
  // 1m / 2 / 5 / 10 / 20 / 50 / 100 / 200 / 500 / 1km / 2km
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
  let cm = nice[0];
  for (const candidate of nice) {
    if (candidate * pxPerCm <= target) cm = candidate;
    else break;
  }
  return {
    cm,
    px: Math.max(1, Math.round(cm * pxPerCm)),
    label: cm >= 100000 ? `${cm / 100000} km` : `${Math.round(cm / 100)} m`,
  };
}

/** 比例尺上给眼睛看的一行（“0 —— 50 m —— 100 m”） */
export function scaleBarTicks(bar) {
  const cm = num(bar && bar.cm);
  const px = num(bar && bar.px);
  if (!(cm > 0) || !(px > 0)) return [];
  const mid = cm / 2;
  const text = (v) => (v >= 100000 ? `${v / 100000} km` : `${Math.round(v / 100)} m`);
  return [
    { px: 0, label: '0' },
    { px: Math.round(px / 2), label: text(mid) },
    { px: Math.round(px), label: text(cm) },
  ];
}

// ── 图注 ────────────────────────────────────────────────────────────────

/**
 * 聚落鸟瞰的图注（与单栋插图共用同一个绘制层，只是内容不同）。
 *
 * @param {object} input
 * @param {string} [input.name] 区域名
 * @param {{buildings:number,wired:number,plain:number,roads:number}} [input.stats]
 * @param {{w:number,h:number}} [input.extentCm] 镇域外接尺寸（cm）
 * @param {string} [input.projection] 投影角短名
 * @param {string|object} [input.preset]
 * @param {{cm:number,px:number,label:string}} [input.scaleBar]
 * @param {string} [input.date]
 * @param {string} [input.version]
 */
export function settlementCaptionModel(input = {}) {
  const stats = input.stats || {};
  const n = Math.max(0, Math.round(num(stats.buildings)));
  const wired = Math.max(0, Math.round(num(stats.wired)));
  const plain = Math.max(0, Math.round(num(stats.plain, n - wired)));
  const roads = Math.max(0, Math.round(num(stats.roads)));
  const ext = input.extentCm || {};
  const meters = (v) => Math.round(num(v) / 100);
  const name = String(input.name || '').trim() || '聚落';

  // 格子一格大约 11 个汉字宽（3600px 宽、5 格、字号 34px）—— 长的别塞进来，会被省略号吃掉
  const buildingsText = n > 0 ? `${n} 栋` : '还没有建筑';
  const extentText = num(ext.w) > 0 && num(ext.h) > 0
    ? `${meters(ext.w)} × ${meters(ext.h)} m`
    : '—';

  const cells = [
    { label: '建筑', value: buildingsText },
    { label: '道路', value: roads > 0 ? `${roads} 条` : '还没有道路' },
    { label: '镇域', value: extentText },
    { label: '投影', value: String(input.projection || '').trim() || '轴测' },
    { label: '方位', value: northText(input.preset) },
  ];

  const date = String(input.date || '').trim();
  const version = String(input.version || '').trim();
  const notes = [];
  if (n > 0) {
    notes.push(plain > 0 ? `${wired} 栋有内部图 · ${plain} 栋只有体块` : `${wired} 栋都有内部图`);
  }
  notes.push('北 = 平面图上方');
  notes.push('比例尺见图左下');
  return {
    title: name,
    subtitle: `聚落鸟瞰${n > 0 ? ` · ${n} 栋` : ''}`,
    cells,
    note: notes.join(' · '),
    footer: `司天${version ? ` v${version}` : ''}${date ? ` · ${date}` : ''}`,
    north: northScreenVector(input.preset),
    scaleBar: input.scaleBar || null,
  };
}
