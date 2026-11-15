// interior/buildShell.js — 建筑外观（3D）几何层：楼层数据 → 墙/门窗洞/屋顶的方盒与三角面
//
// ── 为什么单独一层 ───────────────────────────────────────────────────────
// 3D 里没有任何"新数据"：墙的挤出（thickness × height）、门窗洞、屋顶，全部由平面图那份
// `interiorData[buildingId].floors` 推出来。这一层是**纯函数**（不 import three、不碰 DOM/store），
// 所以几何对不对由 Node 单测判定（`scripts/tests/unit/test_building_shell.js`），
// 而不是靠"看了眼截图觉得像"。
//
// ── 坐标口径（和平面图一致）───────────────────────────────────────────────
//   · 世界单位 = 厘米（与 `utils/interiorUnits.js` 同一口径）。
//   · 平面 (x, y) → 三维 (x, y_up, z=y)。即**俯视方向与平面图完全一致**：从 +z 往 -z 看，
//     画面里的"上"就是平面的 -y。这条不换算，是为了让用户在 2D 与 3D 之间不用重新找方向。
//   · 抬起高度 `elevation`（cm，楼层离地高度）由 `floor.elevation` 给，缺省按 300cm 递增。
//
// ── 墙怎么变盒子（三条纪律）──────────────────────────────────────────────
//   1) 墙不是"粗线"，是**沿墙方向切段 + 竖向切段**的方盒（`solidsAlongWall`）：
//      先把弧长轴按门窗边界切成段，再在每段里把竖直方向 [0, 墙高] 减掉门窗占的区间。
//      这样门窗洞是真洞（没有 CSG，也没有"用背景色涂掉"那种一换底色就露馅的做法）。
//   2) 转角不做斜接：每面墙在**端点处沿自身方向各外延半个墙厚**，把墙角补满。
//      （和平面图 2D 用"圆盖"补接缝是同一个思路，只是 3D 里外延更省事。）
//   3) 弧墙（`curvePoint`）按 16 段采样成折线，门窗按**弧长**投影到折线上 ——
//      弧墙上的门窗不会消失（这是最容易静默失败的一处）。

import {
  subtractRects,
  stairBoxes,
  stairDirection,
  stairHolesForFloor,
  orderFloorsByElevation,
} from './stairs.js';
import { furnitureBoxes } from './furnitureBoxes.js';

/** 屋顶默认参数（cm）。改这里就是改全项目的屋顶观感。 */
export const ROOF_DEFAULTS = Object.freeze({
  kind: 'gable',       // 'gable' 坡顶 / 'flat' 平顶 / 'none' 不封顶（看内部：楼梯、楼板洞口）
  thickness: 18,       // 屋面板厚（平顶）/ 檐口板厚（坡顶）
  fascia: 12,          // 坡顶檐口板（贴在墙顶的那块薄板）
  overhang: 45,        // 出檐（墙外皮再往外伸多少）
  riseRatio: 0.55,     // 坡顶高 = 短边半长 × riseRatio
  minRise: 40,         // 坡顶高下限（小屋别成了一张纸）
  maxRise: 900,        // 坡顶高上限（宫殿别成了针）
});

/** 门窗/墙缺省值（与 store/geodataModules/interior.js 的写口缺省保持一致） */
export const SHELL_DEFAULTS = Object.freeze({
  wallThickness: 12,
  wallHeight: 280,
  floorHeight: 300,
  doorWidth: 90, doorHeight: 200,
  windowWidth: 120, windowHeight: 140, windowSill: 90,
});

/** 外观配色（浅色木石 + 青灰瓦）*/
export const SHELL_COLORS = Object.freeze({
  wall: '#cfc7b8',          // 外墙（比平面图的 #8d7f6e 亮，3D 里要接光）
  wallBase: '#b9b0a0',      // 勒脚/基座
  door: '#8a6242',
  window: '#9fc3d8',
  roofGable: '#5c6672',     // 坡顶瓦
  roofFlat: '#b3ab9c',      // 平顶防水层
  slab: '#e0d9cc',          // 楼层分隔带（楼板侧边）
  fascia: '#8e8676',
  stair: '#c3b191',         // 楼梯踏步（比墙略暖，轴测里能读出“这是木头”）
  furniture: '#a89880',     // 家具缺省色（家具自己带 color 时用家具的）
});

const CURVE_SAMPLES = 16;

// ── 小工具 ───────────────────────────────────────────────────────────────

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 二次贝塞尔采样（start → ctrl → end），返回含首尾的 17 个点 */
function sampleCurve(start, ctrl, end, samples = CURVE_SAMPLES) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * start.x + 2 * mt * t * ctrl.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * ctrl.y + t * t * end.y,
    });
  }
  return pts;
}

/** 折线累计弧长 */
function polylineLens(pts) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return lens;
}

/** 弧长 u 处的点与方向（返回单位向量；u 越界按端点夹取） */
function pointAt(pts, lens, u) {
  const total = lens[lens.length - 1];
  const s = clamp(u, 0, total);
  let i = 1;
  while (i < lens.length - 1 && lens[i] < s) i++;
  const segLen = lens[i] - lens[i - 1];
  const k = segLen > 1e-9 ? (s - lens[i - 1]) / segLen : 0;
  const a = pts[i - 1];
  const b = pts[i];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: a.x + dx * k,
    y: a.y + dy * k,
    dirX: dx / len,
    dirY: dy / len,
  };
}

// ── 墙：弧长轴切段 + 竖向减洞 ─────────────────────────────────────────────

/**
 * 一面墙（直墙或弧墙）要出的所有实心方盒。
 *
 * @param {object} wall      { start, end, thickness, height, curvePoint, color, exteriorColor }
 * @param {number} elevation 本层离地高度（cm）
 * @param {Array}  openings  门窗 [{ kind:'door'|'window', position, width, height, sillHeight }]
 * @returns {Array} 方盒 { kind, color, cx, cy, cz, sx, sy, sz, rotY }
 */
function wallBoxes(wall, elevation, openings, colors) {
  const sx0 = num(wall.start?.x);
  const sy0 = num(wall.start?.y);
  const ex = num(wall.end?.x);
  const ey = num(wall.end?.y);
  const t = num(wall.thickness, SHELL_DEFAULTS.wallThickness) || SHELL_DEFAULTS.wallThickness;
  const h = num(wall.height, SHELL_DEFAULTS.wallHeight) || SHELL_DEFAULTS.wallHeight;
  const color = wall.exteriorColor || wall.color || colors.wall;

  const hasCurve = !!(wall.curvePoint && Number.isFinite(Number(wall.curvePoint.x)));
  const pts = hasCurve
    ? sampleCurve({ x: sx0, y: sy0 }, { x: num(wall.curvePoint.x), y: num(wall.curvePoint.y) }, { x: ex, y: ey })
    : [{ x: sx0, y: sy0 }, { x: ex, y: ey }];
  const lens = polylineLens(pts);
  const total = lens[lens.length - 1];
  if (!(total > 1)) return [];

  // 门窗投影到弧长轴（position 是 0..1 的比例，不是绝对长度）
  const holes = [];
  for (const o of openings || []) {
    const w = num(o.width, o.kind === 'door' ? SHELL_DEFAULTS.doorWidth : SHELL_DEFAULTS.windowWidth);
    const oh = num(o.height, o.kind === 'door' ? SHELL_DEFAULTS.doorHeight : SHELL_DEFAULTS.windowHeight);
    const center = clamp(num(o.position, 0.5), 0, 1) * total;
    const half = Math.min(w, total) / 2;
    const sill = o.kind === 'door' ? 0 : num(o.sillHeight, SHELL_DEFAULTS.windowSill);
    holes.push({
      s: clamp(center - half, 0, total),
      e: clamp(center + half, 0, total),
      y0: clamp(sill, 0, h),
      y1: clamp(sill + oh, 0, h),
      kind: o.kind,
      color: o.kind === 'door' ? colors.door : colors.window,
    });
  }
  // 竖切边界：墙两端 + 所有洞的两端（重叠/贴边都在这里归一）+ 弧墙的采样点
  // （弧墙必须逐段成盒，否则"弧"只剩一条弦 —— 第一版就漏了这一步）
  const cuts = new Set([0, total]);
  for (const hy of holes) { cuts.add(hy.s); cuts.add(hy.e); }
  if (hasCurve) for (let i = 1; i < lens.length - 1; i++) cuts.add(lens[i]);
  const bounds = [...cuts].sort((a, b) => a - b);

  const boxes = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const u0 = bounds[i];
    const u1 = bounds[i + 1];
    if (u1 - u0 < 0.2) continue;
    const mid = (u0 + u1) / 2;

    // 这一段竖直方向要减掉哪些洞
    const cover = holes.filter((hy) => hy.s <= mid && mid <= hy.e);

    // 实心竖向区间 [0, h] 减洞
    let ranges = [[0, h]];
    if (cover.length) {
      const next = [];
      for (const [lo, hi] of ranges) {
        let pieces = [[lo, hi]];
        for (const hy of cover) {
          const out = [];
          for (const [a, b] of pieces) {
            if (hy.y1 <= a || hy.y0 >= b) { out.push([a, b]); continue; }
            if (hy.y0 > a) out.push([a, hy.y0]);
            if (hy.y1 < b) out.push([hy.y1, b]);
          }
          pieces = out;
        }
        next.push(...pieces);
      }
      ranges = next;
    }

    const at = pointAt(pts, lens, mid);
    const rotY = Math.atan2(-at.dirY, at.dirX);
    // 端点外延半个墙厚：把墙角补满（不做斜接）
    let uStart = u0;
    let uEnd = u1;
    if (u0 === 0) uStart -= t / 2;
    if (u1 === total) uEnd += t / 2;
    const len = uEnd - uStart;
    if (!(len > 0)) continue;
    // 外延是单边的（只有靠端点那一侧），盒子中心要跟着沿墙方向挪半个外延量，
    // 否则墙的中心会偏 t/4，转角处补出来的角是歪的。
    const shift = (uStart + uEnd) / 2 - mid;

    for (const [y0, y1] of ranges) {
      const hh = y1 - y0;
      if (hh < 0.5) continue;
      boxes.push({
        kind: 'wall',
        color,
        cx: at.x + at.dirX * shift,
        cy: elevation + (y0 + y1) / 2,
        cz: at.y + at.dirY * shift,
        sx: len,
        sy: hh,
        sz: t,
        rotY,
      });
    }

    // 洞里的填充（门扇 / 窗玻璃）：有洞才有，让洞看起来"有东西"
    for (const hy of cover) {
      if (hy.y1 - hy.y0 < 1) continue;
      boxes.push({
        kind: hy.kind === 'door' ? 'door' : 'window',
        color: hy.color,
        cx: at.x,
        cy: elevation + (hy.y0 + hy.y1) / 2,
        cz: at.y,
        sx: u1 - u0,
        sy: hy.y1 - hy.y0,
        sz: hy.kind === 'door' ? 5 : 2.5,
        rotY,
      });
    }
  }
  return boxes;
}

// ── 凸包 + 最小外接矩形（屋顶用）─────────────────────────────────────────

export function convexHull(points) {
  const pts = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-6) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-6) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * 最小面积外接矩形（旋转卡壳）。返回 { cx, cy, ux, uy, halfW, halfD }：
 * 中心、长轴单位向量、沿长轴的半长、垂直长轴的半宽（cm）。
 */
export function minAreaRect(hull) {
  const n = hull.length;
  if (n < 3) return null;
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) continue;
    const ux = dx / len;
    const uy = dy / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pv = -p.x * uy + p.y * ux;
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-6) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        // 反投影回平面坐标：p = u * cu + v * cv
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        ux, uy,
        halfU: (maxU - minU) / 2,
        halfV: (maxV - minV) / 2,
      };
    }
  }
  if (!best) return null;
  // 长轴统一：让 ux,uy 指长边方向
  if (best.halfU < best.halfV) {
    return {
      cx: best.cx, cy: best.cy,
      ux: -best.uy, uy: best.ux,
      halfW: best.halfV, halfD: best.halfU,
    };
  }
  return { cx: best.cx, cy: best.cy, ux: best.ux, uy: best.uy, halfW: best.halfU, halfD: best.halfV };
}

/**
 * 屋顶几何。返回 { kind, fascia, tris, boxes, stats }：
 *   · 平顶 = 一块厚板（box）+ 檐口板
 *   · 坡顶 = 檐口板 + 2 个梯形坡面 + 2 个三角坡面（全部三角面，渲染层直接建 BufferGeometry）
 */
function roofGeometry(endpoints, topY, opt, colors) {
  const hull = convexHull(endpoints);
  const rect = minAreaRect(hull);
  if (!rect) return null;
  const { cx, cy, ux, uy, halfW, halfD } = rect;
  const ov = Math.max(0, num(opt.overhang, ROOF_DEFAULTS.overhang));
  const hw = halfW + ov;
  const hd = halfD + ov;
  // 长轴 rotY：平面 (ux,uy) → 世界绕 Y 角（与墙同一套换算）
  const rotY = Math.atan2(-uy, ux);

  const fasciaThickness = num(opt.fascia, ROOF_DEFAULTS.fascia);
  const fascia = {
    kind: 'roof',
    color: colors.fascia,
    cx,
    cy: topY - fasciaThickness / 2 + 1,
    cz: cy,
    sx: 2 * hw,
    sy: fasciaThickness,
    sz: 2 * hd,
    rotY,
  };

  if ((opt.kind || ROOF_DEFAULTS.kind) === 'flat') {
    const th = num(opt.thickness, ROOF_DEFAULTS.thickness);
    return {
      kind: 'flat',
      fascia,
      boxes: [{
        kind: 'roof',
        color: colors.roofFlat,
        cx,
        cy: topY + th / 2,
        cz: cy,
        sx: 2 * hw,
        sy: th,
        sz: 2 * hd,
        rotY,
      }],
      faces: [],
      tris: [],
      stats: { ridgeHeight: 0 },
    };
  }

  // 坡顶高：拿短边半长做基准，再夹在上下限之间
  const shortHalf = Math.min(hw, hd);
  let rise = shortHalf * num(opt.riseRatio, ROOF_DEFAULTS.riseRatio);
  rise = clamp(rise, num(opt.minRise, ROOF_DEFAULTS.minRise), num(opt.maxRise, ROOF_DEFAULTS.maxRise));
  const ridgeY = topY + rise;

  // 檐口四角（平面 → 世界 (x, z)）
  const corner = (a, b) => ({ x: cx + ux * a - uy * b, z: cy + uy * a + ux * b });
  const cA = corner(hw, hd);
  const cB = corner(-hw, hd);
  const cC = corner(-hw, -hd);
  const cD = corner(hw, -hd);

  // 屋脊：沿长轴；两坡相接处到两端各内收 halfD（四坡顶的标准做法）
  const ridgeHalf = Math.max(0, hw - hd);
  const rCenter = { x: cx, z: cy };
  const r1 = { x: rCenter.x - ux * ridgeHalf, z: rCenter.z - uy * ridgeHalf };
  const r2 = { x: rCenter.x + ux * ridgeHalf, z: rCenter.z + uy * ridgeHalf };

  const V = (p, y) => [p.x, y, p.z];
  // faces = 一个坡面（3 或 4 点）。渲染层按**面**算法线：
  // 直接用三角面算会在每个四边形内部留下一条对角折痕（实测截图里能看到"拼板"缝）。
  const faces = [];
  const tris = [];
  const tri = (a, b, c) => { faces.push([a, b, c]); tris.push([a, b, c]); };
  const quad = (a, b, c, d) => {
    faces.push([a, b, c, d]);
    tris.push([a, b, c], [a, c, d]);
  };

  const eave = topY;
  // +v 侧坡面：A(+hw,+hd) B(-hw,+hd) → 屋脊
  quad(V(cA, eave), V(cB, eave), V(r1, ridgeY), V(r2, ridgeY));
  // -v 侧坡面：D(+hw,-hd) C(-hw,-hd) → 屋脊
  quad(V(cD, eave), V(cC, eave), V(r1, ridgeY), V(r2, ridgeY));
  // 两端山墙斜面
  tri(V(cA, eave), V(cD, eave), V(r2, ridgeY));
  tri(V(cB, eave), V(cC, eave), V(r1, ridgeY));

  return {
    kind: 'gable',
    fascia,
    boxes: [],
    faces,
    tris,
    stats: { ridgeHeight: rise, eaveY: eave, ridgeY },
  };
}

// ── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 把整栋楼的楼层数据变成 3D 外壳。
 *
 * @param {Array} floors store 里的 floors（可含 walls/doors/windows，老数据可能只有 furniture）
 * @param {object} [options] { roof:{kind,overhang,...}, style:{wall,roofGable,...} }
 * @returns {{
 *   boxes: Array, roof: object|null, bounds: object, stats: object, empty: boolean
 * }}
 */
export function buildBuildingShell(floors, options = {}) {
  const opt = { ...ROOF_DEFAULTS, ...(options.roof || {}) };
  const colors = { ...SHELL_COLORS, ...(options.style || {}) };
  const list = Array.isArray(floors) ? floors.filter(Boolean) : [];

  const boxes = [];
  const wallEndpoints = [];
  let wallCount = 0;
  let openingCount = 0;
  let stairCount = 0;
  let furnitureCount = 0;
  let topY = 0;

  // 楼层按 elevation 升序处理（用户可能改了层高顺序）。
  // 排序走 `stairs.js` 的**同一份**实现：楼梯要找"上一层/下一层"，两处排法不一致就会出现
  // "平面图说通到 2F、3D 里通到 3F"（同标高两层来回换位时尤其隐蔽）。
  const ordered = orderFloorsByElevation(list);
  // 每层的"顶标高 + 自己的外接矩形"—— 楼板要用（下一层墙顶到本层地面之间那条缝）
  const floorSeats = [];
  ordered.forEach((floor, idx) => {
    const elevation = Number.isFinite(Number(floor.elevation))
      ? num(floor.elevation)
      : idx * SHELL_DEFAULTS.floorHeight;
    const walls = Array.isArray(floor.walls) ? floor.walls : [];
    const doors = Array.isArray(floor.doors) ? floor.doors : [];
    const windows = Array.isArray(floor.windows) ? floor.windows : [];

    for (const wall of walls) {
      wallCount++;
      wallEndpoints.push(
        { x: num(wall.start?.x), y: num(wall.start?.y) },
        { x: num(wall.end?.x), y: num(wall.end?.y) },
      );
      const openings = [];
      for (const d of doors) if (d && d.wallId === wall.id) openings.push({ ...d, kind: 'door' });
      for (const w of windows) if (w && w.wallId === wall.id) openings.push({ ...w, kind: 'window' });
      openingCount += openings.length;
      boxes.push(...wallBoxes(wall, elevation, openings, colors));
      const h = num(wall.height, SHELL_DEFAULTS.wallHeight) || SHELL_DEFAULTS.wallHeight;
      topY = Math.max(topY, elevation + h);
    }

    // 家具（2026-11-15，A20）：每件家具一块体积，高度按类型查表。
    // 屋顶封着的时候看不见（这是对的：室内家具不该从外面透出来），
    // 把屋顶切到“不封顶”就能从上方看到房间里的床/桌/柜 —— 与楼梯、楼板洞口同一条观察路径。
    // `options.furniture === false` 可关（实时预览不需要时省掉几十个 mesh）。
    if (options.furniture !== false) {
      const furniture = Array.isArray(floor.furniture) ? floor.furniture : [];
      const fboxes = furnitureBoxes(furniture, elevation, { color: colors.furniture });
      furnitureCount += fboxes.length;
      boxes.push(...fboxes);
    }

    // 楼梯（2026-11-15，A24）：每级踏步一块板。目标层决定升量 ——
    // 上行看下一层、下行看上一层；没有目标层就按默认层高估（悬空的一跑，用户自己看着办）。
    const stairs = Array.isArray(floor.stairs) ? floor.stairs : [];
    for (const stair of stairs) {
      if (!stair) continue;
      stairCount++;
      const target = stairDirection(stair) === 'down' ? ordered[idx - 1] : ordered[idx + 1];
      boxes.push(...stairBoxes(stair, {
        ownElevation: elevation,
        targetElevation: target ? num(target.elevation, 0) : undefined,
        color: colors.stair,
      }));
    }

    const ownPts = [];
    for (const wall of walls) {
      ownPts.push({ x: num(wall.start?.x), y: num(wall.start?.y) }, { x: num(wall.end?.x), y: num(wall.end?.y) });
    }
    const rect = ownPts.length >= 3 ? minAreaRect(convexHull(ownPts)) : null;
    floorSeats.push({ floor, elevation, top: elevation + maxWallTop(walls), rect, level: idx });
  });

  // 🔴 楼板：层高 300 而墙高 280 时，两层之间会留一条 **20cm 的透光缝**（第一版截图里
  // 就是一道贯穿整栋的横亮线）。补一块楼板把缝填上，顺带在立面上形成楼层分隔带。
  // 只有"本层地面高于下一层墙顶"时才补（墙高 ≥ 层高的情况本来就贴在一起，补了会插进墙里）。
  //
  // 2026-11-15（A16/A24）：楼板不再是"一整块"—— 楼梯要穿过去，所以按洞口差集切成若干块。
  // 洞口来源只有一条：`stairs.js` 的 `stairHolesForFloor()`（下层上行梯 + 本层下行梯）。
  // 不在本文件里另算一遍位置，否则"板上有洞但洞不在楼梯正上方"是必然的。
  let prevTop = -Infinity;
  for (const seat of floorSeats) {
    if (seat.rect && Number.isFinite(prevTop) && seat.elevation > prevTop + 1) {
      const gap = seat.elevation - prevTop;
      const holes = seat.floor && seat.floor.id
        ? stairHolesForFloor(ordered, seat.floor.id)
        : [];
      boxes.push(...slabBoxes(seat, prevTop, gap, holes, colors));
    }
    prevTop = Math.max(prevTop, seat.top);
  }

  const roof = (opt.kind !== 'none' && wallEndpoints.length >= 3)
    ? roofGeometry(wallEndpoints, topY, opt, colors)
    : null;

  // 包围盒（给相机取景 / 地面尺寸用）
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const eat = (x, y, z) => {
    min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
  };
  const allBoxes = [...boxes, ...(roof ? [roof.fascia, ...(roof.boxes || [])] : [])];
  for (const b of allBoxes) {
    // 盒子有旋转：按四个角算轴对齐包围盒（少算会裁掉一角）
    const cos = Math.cos(b.rotY || 0);
    const sin = Math.sin(b.rotY || 0);
    const hx = b.sx / 2;
    const hz = b.sz / 2;
    for (const [dx, dz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]]) {
      eat(b.cx + dx * cos + dz * sin, b.cy - b.sy / 2, b.cz - dx * sin + dz * cos);
      eat(b.cx + dx * cos + dz * sin, b.cy + b.sy / 2, b.cz - dx * sin + dz * cos);
    }
  }
  for (const t of roof?.tris || []) for (const p of t) eat(p[0], p[1], p[2]);

  const empty = allBoxes.length === 0 && !(roof?.tris || []).length;
  const bounds = empty
    ? { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] }
    : {
      min, max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    };

  return {
    boxes: allBoxes,     // 墙 + 门窗填充 + 檐口 + 顶板：渲染层一份列表画完
    roof,
    bounds,
    empty,
    stats: {
      floors: ordered.length,
      walls: wallCount,
      openings: openingCount,
      stairs: stairCount,
      furniture: furnitureCount,
      boxes: allBoxes.length,
      roofTriangles: (roof?.tris || []).length,
      height: bounds.size[1],
    },
  };
}

/**
 * 一块楼板（可能被楼梯洞口切成若干块）。
 *
 * 只在楼板自己的**局部坐标系**里做矩形差集：`minAreaRect` 给的是任意角度的矩形，
 * 在世界坐标里直接切会得到斜边；转到 (u,v) 后洞也变成矩形，`subtractRects` 就能算准。
 *
 * @param {object} seat  { rect, elevation }  —— rect = minAreaRect 的结果
 * @param {number} prevTop 下一层墙顶标高（板底面）
 * @param {number} gap     板厚（cm）
 * @param {Array<{poly:Array}>} holes 洞口多边形（世界坐标）
 */
function slabBoxes(seat, prevTop, gap, holes, colors) {
  const r = seat.rect;
  const rotY = Math.atan2(-r.uy, r.ux);
  const cy = (prevTop + seat.elevation) / 2;
  const base = { kind: 'slab', color: colors.slab, cy, sy: gap, rotY };
  if (!r || !(r.halfW > 0) || !(r.halfD > 0)) return [];
  const toLocal = (p) => {
    const dx = num(p && p.x) - r.cx;
    const dy = num(p && p.y) - r.cy;
    return { u: dx * r.ux + dy * r.uy, v: -dx * r.uy + dy * r.ux };
  };
  const localHoles = [];
  for (const h of holes || []) {
    const pts = (h && h.poly) || [];
    if (!pts.length) continue;
    let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
    for (const p of pts) {
      const q = toLocal(p);
      u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u);
      v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v);
    }
    localHoles.push({ u0, u1, v0, v1 });
  }
  const pieces = subtractRects(
    { u0: -r.halfW, u1: r.halfW, v0: -r.halfD, v1: r.halfD },
    localHoles,
  );
  return pieces.map((pr) => {
    const uc = (pr.u0 + pr.u1) / 2;
    const vc = (pr.v0 + pr.v1) / 2;
    return {
      ...base,
      cx: r.cx + r.ux * uc - r.uy * vc,
      cz: r.cy + r.uy * uc + r.ux * vc,
      sx: pr.u1 - pr.u0,
      sz: pr.v1 - pr.v0,
    };
  });
}

/** 一层墙的最高点（cm）：墙高缺省 280 */
function maxWallTop(walls) {
  let top = 0;
  for (const w of walls || []) {
    top = Math.max(top, num(w.height, SHELL_DEFAULTS.wallHeight) || SHELL_DEFAULTS.wallHeight);
  }
  return top;
}

/** 楼层里有没有墙（UI 用来决定"外观"按钮亮不亮）*/
export function hasWalls(floors) {
  return (Array.isArray(floors) ? floors : []).some((f) => Array.isArray(f?.walls) && f.walls.length > 0);
}
