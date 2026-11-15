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
 * ## 已知限制（写在这里，不藏着）
 *
 * 占地用的是**墙端点的凸包**：L 形、凹字形建筑会把凹处填平。
 * 要精确轮廓需要多边形布尔（`utils/polygonBool.js` 有引擎，但是注入式的），
 * 那一步等真有异形建筑的需求再做 —— 先把"色点 → 有形状的符号"这一步走完。
 */

// 带 .js 后缀：项目里已有这个惯例（riverRender / provinceShape 都这么写），
// 好处是同一份代码既能在 Vite 里跑、也能被 Node 单测直接 import。
import { convexHull, minAreaRect } from './buildShell.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 俯视符号配色（与轴测插图同一套纸面观感，但更淡 —— 地图上不能抢地形） */
export const SYMBOL_COLORS = Object.freeze({
  roof: '#cbbba4',
  roofFlat: '#d5cfc3',
  roofRidge: '#8d7f6e',
  edge: '#4a4136',
  shadow: 'rgba(60, 48, 32, 0.22)',
  wallLine: '#6b5f50',
});

/**
 * 从楼层数据算占地。
 *
 * @param {Array<object>} floors `[{ walls:[{start,end,thickness}], elevation, ... }]`
 * @param {{pad?:number}} [opts] pad：轮廓外扩（cm），默认按最厚墙的一半
 * @returns {null | {
 *   ring: Array<{x:number,y:number}>,       // 凸包（世界 cm，逆时针/顺时针不保证）
 *   rect: {cx:number, cy:number, width:number, depth:number, angle:number}, // 最小外接矩形（angle: 弧度）
 *   area: number,                            // 占地（cm²）
 *   bbox: {minX:number, minY:number, maxX:number, maxY:number},
 *   floors: number, walls: number, maxWallTop: number
 * }}
 *   没有任何墙返回 null（调用方按"旧色点"回落）
 */
export function buildFootprint(floors, opts = {}) {
  const list = Array.isArray(floors) ? floors : [];
  const pts = [];
  let wallCount = 0;
  let maxThick = 0;
  let maxWallTop = 0;
  let floorCount = 0;

  for (const floor of list) {
    const walls = (floor && floor.walls) || [];
    if (walls.length) floorCount += 1;
    for (const w of walls) {
      if (!w || !w.start || !w.end) continue;
      const ax = num(w.start.x);
      const ay = num(w.start.y);
      const bx = num(w.end.x);
      const by = num(w.end.y);
      const len = Math.hypot(bx - ax, by - ay);
      if (!(len > 1)) continue;                 // 退化墙不计入
      wallCount += 1;
      const t = Math.max(2, num(w.thickness, 12));
      maxThick = Math.max(maxThick, t);
      // 墙按厚度外扩：两端各外扩半个墙厚、法向各让半个墙厚 —— 只用端点会让轮廓小于实际占地
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const half = t / 2;
      for (const [px, py] of [[ax, ay], [bx, by]]) {
        for (const [su, sn] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          pts.push({ x: px + ux * su * half - uy * sn * half, y: py + uy * su * half + ux * sn * half });
        }
      }
      // 墙顶标高：给"层数/高度"用
      maxWallTop = Math.max(maxWallTop, num(w.height, 280));
    }
  }

  if (!pts.length) return null;
  const hull = convexHull(pts);
  if (!hull || hull.length < 3) return null;

  // 最小外接矩形给出"长轴方向"——屋顶脊线要沿线走，符号的朝向也靠它
  const mr = minAreaRect(hull) || null;

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // 多边形面积（鞋带公式）
  let area2 = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    area2 += a.x * b.y - b.x * a.y;
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
    ring: hull,
    rect,
    area: Math.abs(area2) / 2,
    bbox: { minX, minY, maxX, maxY },
    floors: Math.max(1, floorCount),
    walls: wallCount,
    maxWallTop,
    pad: opts.pad !== undefined ? num(opts.pad) : maxThick / 2,
  };
}

/**
 * 俯视屋顶线。
 *
 * 双坡（gable）：沿长轴一条脊线 + 两侧檐线（檐线就是轮廓本身，画的时候取轮廓即可）。
 * 平顶（flat）：一条内缩的"女儿墙/防水层边"。
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
  const ring = footprint.ring;

  const path = () => {
    ctx.beginPath();
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  };

  ctx.save();

  // ① 投影：轮廓沿右下偏移，让人一眼看出"这是个有高度的东西"（不是一块地面色斑）
  if (opts.shadow !== false) {
    // 🔴 偏移量必须是**屏幕像素**换算回世界单位：第一版按"长轴 × 6%%"算（最大 12cm），
    //    地图缩小时只有 2~3px 且被屋顶盖住 → 完全看不见投影，房子又变成一块平色块。
    const offPx = 3.5;
    const off = offPx / zoom;
    ctx.save();
    ctx.translate(off, off * 1.1);
    path();
    ctx.fillStyle = pal.shadow;
    ctx.fill();
    ctx.restore();
  }

  // ② 屋顶面
  path();
  ctx.fillStyle = roof === 'flat' ? pal.roofFlat : pal.roof;
  ctx.fill();

  // ③ 轮廓（墨线）：选中时加粗并加一圈亮边
  ctx.strokeStyle = opts.selected ? '#ffd24a' : pal.edge;
  ctx.lineWidth = (opts.selected ? 2.6 : 1.6) / zoom;
  ctx.stroke();
  if (opts.selected) {
    ctx.strokeStyle = 'rgba(255, 210, 74, 0.45)';
    ctx.lineWidth = 6 / zoom;
    ctx.stroke();
  }

  // ④ 屋顶线：坡顶画脊线；平顶画内缩一圈（女儿墙/防水边）
  if (roof !== 'flat') {
    const plan = roofPlan(footprint, roof === 'gable' ? 'gable' : 'hip');
    if (plan.ridge) {
      ctx.beginPath();
      ctx.moveTo(plan.ridge[0].x, plan.ridge[0].y);
      ctx.lineTo(plan.ridge[1].x, plan.ridge[1].y);
      ctx.strokeStyle = pal.roofRidge;
      ctx.lineWidth = 1.2 / zoom;
      ctx.stroke();
    }
    // 斜脊只在**四坡顶且轮廓确实是矩形**时画。
    // 🔴 L 形建筑：凸包 ≠ 外接矩形，四个角里的两个落在轮廓外 → 会画出悬空的斜线
    //    （2026-11-15 样图第一版就是这样，右下角一条线飘在形状外面）。
    const isRect = ring.length === 4
      && Math.abs(footprint.area - footprint.rect.long * footprint.rect.short)
        / Math.max(1, footprint.rect.long * footprint.rect.short) < 0.08;
    const wantHips = roof !== 'flat' && roof !== 'gable' && isRect;
    const { cx, cy, u, v, halfU, halfV } = footprint.rect;
    const corners = [
      { x: cx - u.x * halfU - v.x * halfV, y: cy - u.y * halfU - v.y * halfV },
      { x: cx + u.x * halfU - v.x * halfV, y: cy + u.y * halfU - v.y * halfV },
      { x: cx + u.x * halfU + v.x * halfV, y: cy + u.y * halfU + v.y * halfV },
      { x: cx - u.x * halfU + v.x * halfV, y: cy - u.y * halfU + v.y * halfV },
    ];
    // 只在矩形的四个角连到脊线端点（近似：取离脊线端点最近的两角）
    if (plan.ridge && wantHips) {
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
    // 平顶：轮廓内缩 8% 画一圈
    const cx = (footprint.bbox.minX + footprint.bbox.maxX) / 2;
    const cy = (footprint.bbox.minY + footprint.bbox.maxY) / 2;
    ctx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const px = cx + (ring[i].x - cx) * 0.86;
      const py = cy + (ring[i].y - cy) * 0.86;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = pal.wallLine;
    ctx.lineWidth = 0.9 / zoom;
    ctx.stroke();
  }

  ctx.restore();
  return true;
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
