// interior/renderFloor.js — 建筑内部一层的绘制（纯函数，2026-11-13）
//
// ── 为什么独立成文件 ──────────────────────────────────────────────────────
// `InteriorView.vue` 已经 1,900+ 行，再往里塞墙/房间/门窗的绘制会变成第二个 ScenarioMap。
// 这里只做"给 ctx + 数据 → 画出来"，不碰 store、不碰响应式，和 `scenario/layers/*` 同一纪律。
//
// ── 坐标系 ───────────────────────────────────────────────────────────────
// 调用方保证 ctx 已被 `translate(视口中心) + scale(zoom)` 变换过，所以这里**一律用世界坐标**
// （单位 cm）。线宽、字号这类"要恒定的屏幕尺寸"必须手动除以 zoom。
//
// ── 技法来源 ─────────────────────────────────────────────────────────────
// theLodgeBots/open3dFloorplan v0.9.0（MIT）`canvasRenderer.ts`，改了两处：
//   ① 门窗开口**不涂背景色**（原版涂写死 #fafafa，深色底/渐变底会露馅）。
//      这里改成"把墙沿长度切成若干段，开口处直接不画" —— 无覆盖、无露馅。
//   ② 转角不做斜接，用圆盖补缝（原版同款）：按端点聚合，凡 ≥2 面墙共用的端点画一个实心圆。

import { formatArea, formatLength } from '../utils/interiorUnits';
import { getRoomPolygon, polygonArea } from '../utils/roomDetection';
import { stairFootprint, stairTreads, stairDirection } from './stairs.js';

const DEFAULT_WALL_COLOR = '#8d7f6e';

/**
 * 两套配色（2026-11-14）：屏幕是深底、亮蓝房间；**出图必须换白纸**，
 * 否则打印出来是一张黑纸。出图不能"另画一遍"（那是双源，改一处漏一处），
 * 所以用同一套绘制函数，只换主题。
 */
export const FLOOR_THEMES = Object.freeze({
  screen: {
    roomFill: 'rgba(126, 176, 229, 0.26)',
    roomStroke: 'rgba(147, 197, 253, 0.55)',
    roomText: '#e8eef7',
    roomTextHalo: 'rgba(10, 14, 22, 0.9)',
    wall: DEFAULT_WALL_COLOR,
    wallStroke: 'rgba(0,0,0,0.35)',
    joint: DEFAULT_WALL_COLOR,
    door: '#d9b45a',
    window: '#7fc7e8',
    stairFill: 'rgba(185, 168, 136, 0.20)',
    stairLine: '#8a7a5e',
    stairText: '#5d5140',
    holeFill: 'rgba(120, 120, 130, 0.10)',
    holeLine: 'rgba(110, 110, 125, 0.55)',
    dimText: '#9fb0c0',
    dimBg: 'rgba(20, 24, 32, 0.72)',
  },
  print: {
    roomFill: '#e8eff7',        // 白纸上要看得出"这一间"（原来是 #eef1f5，几乎与纸同色）
    roomStroke: '#b9c9da',
    roomText: '#2f3742',
    roomTextHalo: 'rgba(255,255,255,0.92)',
    wall: '#3e4348',            // 平面图里墙是"涂黑"的（poche），不跟屏幕的棕色
    wallStroke: 'rgba(0,0,0,0.55)',
    joint: '#3e4348',
    door: '#7a5a2e',            // 门窗在白底上要够深，否则像没画
    window: '#2f6f95',
    stairFill: 'rgba(140, 125, 98, 0.16)',
    stairLine: '#4a3f2c',
    stairText: '#2f2a20',
    holeFill: 'rgba(90, 95, 105, 0.07)',
    holeLine: 'rgba(70, 75, 85, 0.45)',
    dimText: '#6b7783',
    dimBg: 'rgba(255,255,255,0.86)',
  },
});

/** 取主题（未知值回落屏幕态，免得调用方写错就白纸） */
export function floorTheme(name) {
  return FLOOR_THEMES[name] || FLOOR_THEMES.screen;
}

/** 墙的可见长度（直线；弧墙按弦长近似） */
function wallLen(w) {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  return Math.hypot(dx, dy);
}

/** 墙上 t∈[0,1] 处的点 */
function wallPointAt(w, t) {
  return {
    x: w.start.x + (w.end.x - w.start.x) * t,
    y: w.start.y + (w.end.y - w.start.y) * t,
  };
}

/** 墙在 t 处的单位法向量 */
function wallNormal(w) {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

/**
 * 把一面墙按挂在上面的门窗切成若干"实心段"（t 区间）。
 * 开口按 position（0..1）与 width（cm）换算成 t 区间，重叠的合并。
 */
export function wallSolidSegments(wall, openings) {
  const len = wallLen(wall);
  if (!(len > 0)) return [];
  const gaps = [];
  for (const o of openings || []) {
    if (!o) continue;
    const half = Math.max(0, Number(o.width) || 0) / 2;
    const c = (Number(o.position) || 0) * len;
    const t0 = Math.max(0, (c - half) / len);
    const t1 = Math.min(1, (c + half) / len);
    if (t1 > t0) gaps.push([t0, t1]);
  }
  if (!gaps.length) return [[0, 1]];
  gaps.sort((a, b) => a[0] - b[0]);
  const merged = [gaps[0].slice()];
  for (let i = 1; i < gaps.length; i++) {
    const last = merged[merged.length - 1];
    if (gaps[i][0] <= last[1] + 1e-9) last[1] = Math.max(last[1], gaps[i][1]);
    else merged.push(gaps[i].slice());
  }
  const out = [];
  let cursor = 0;
  for (const [g0, g1] of merged) {
    if (g0 - cursor > 1e-6) out.push([cursor, g0]);
    cursor = Math.max(cursor, g1);
  }
  if (1 - cursor > 1e-6) out.push([cursor, 1]);
  return out;
}

/** 一段墙的四角多边形（世界坐标） */
function segmentQuad(wall, t0, t1, thickness) {
  const a = wallPointAt(wall, t0);
  const b = wallPointAt(wall, t1);
  const n = wallNormal(wall);
  const h = Math.max(1, thickness) / 2;
  return [
    { x: a.x + n.x * h, y: a.y + n.y * h },
    { x: b.x + n.x * h, y: b.y + n.y * h },
    { x: b.x - n.x * h, y: b.y - n.y * h },
    { x: a.x - n.x * h, y: a.y - n.y * h },
  ];
}

function pathPolygon(ctx, pts) {
  if (!pts || pts.length < 3) return false;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  return true;
}

/**
 * 画一层：房间填充 → 墙 → 转角圆盖 → 门窗符号 → 房间名/面积。
 *
 * @param {CanvasRenderingContext2D} ctx 已按相机变换过
 * @param {object} floor { walls, rooms, doors, windows }
 * @param {object} [opts]
 * @param {number} [opts.zoom=1] 当前缩放（px per cm），用于线宽/字号补偿
 * @param {boolean} [opts.showRooms=true]
 * @param {boolean} [opts.showLabels=true]
 * @param {boolean} [opts.showOpenings=true]
 * @param {boolean} [opts.showDimensions=true] 沿墙长度标注
 * @param {string} [opts.selectedWallId]
 * @param {string} [opts.selectedOpeningId] 选中的门窗 id（画高亮框）
 * @param {Array}  [opts.holes] 本层楼板上的洞（`stairs.js` 的 `stairHolesForFloor()` 输出）
 * @param {string} [opts.selectedStairId] 选中的楼梯 id（画高亮框）
 * @param {boolean} [opts.showStairs=true]
 * @returns {{walls:number, rooms:number, doors:number, windows:number, stairs:number}} 实际画了多少
 */
export function drawInteriorFloor(ctx, floor, opts = {}) {
  const zoom = Number(opts.zoom) > 0 ? Number(opts.zoom) : 1;
  const theme = floorTheme(opts.theme);
  const walls = Array.isArray(floor && floor.walls) ? floor.walls : [];
  const rooms = Array.isArray(floor && floor.rooms) ? floor.rooms : [];
  const doors = Array.isArray(floor && floor.doors) ? floor.doors : [];
  const windows = Array.isArray(floor && floor.windows) ? floor.windows : [];
  const stairs = Array.isArray(floor && floor.stairs) ? floor.stairs : [];
  const showRooms = opts.showRooms !== false;
  const showLabels = opts.showLabels !== false;
  const showOpenings = opts.showOpenings !== false;
  const stat = { walls: 0, rooms: 0, doors: 0, windows: 0, stairs: 0 };

  // ① 房间（墙下面那层）
  if (showRooms && rooms.length) {
    for (const room of rooms) {
      const poly = getRoomPolygon(room, walls);
      if (poly.length < 3) continue;
      if (!pathPolygon(ctx, poly)) continue;
      ctx.save();
      ctx.fillStyle = room.color || theme.roomFill;
      ctx.fill();
      ctx.strokeStyle = room.color || theme.roomStroke;
      ctx.lineWidth = 1 / zoom;
      ctx.stroke();
      ctx.restore();
      stat.rooms++;

      if (showLabels) {
        const area = polygonArea(poly);
        const label = room.name ? `${room.name}  ${formatArea(area)}` : formatArea(area);
        const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
        const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1 / zoom, 1 / zoom);          // 字号按屏幕像素给
        ctx.font = '13px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 深色底 + 浅色字，描边保证压在任何底色上都读得出
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = theme.roomTextHalo;
        ctx.strokeText(label, 0, 0);
        ctx.fillStyle = theme.roomText;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }

  // ①.5 楼板洞口 → 楼梯（2026-11-15，A16/A24）
  // 洞先画（虚线压在房间填充上、楼梯下面）：读图顺序是"这里是个洞，洞里有楼梯上来"。
  if (opts.holes && opts.holes.length) drawFloorHoles(ctx, opts.holes, { zoom, theme });
  if (opts.showStairs !== false) {
    for (const stair of stairs) {
      if (!stair) continue;
      // 每部楼梯的升量各不相同（上行看上一层、下行看下一层），所以按楼梯取上下文，
      // 不用整层一个值 —— 少了这一层，一层楼里同时有上行和下行时必有一边画错。
      const ctxOpt = typeof opts.stairContext === 'function'
        ? opts.stairContext(stair)
        : { ownElevation: opts.ownElevation, targetElevation: opts.targetElevation };
      drawStairSymbol(ctx, stair, {
        zoom,
        theme,
        ownElevation: ctxOpt && ctxOpt.ownElevation,
        targetElevation: ctxOpt && ctxOpt.targetElevation,
        selected: !!opts.selectedStairId && opts.selectedStairId === stair.id,
      });
      stat.stairs++;
    }
  }

  // ② 墙（按开口切段）
  for (const wall of walls) {
    const ownDoors = doors.filter((d) => d.wallId === wall.id);
    const ownWins = windows.filter((d) => d.wallId === wall.id);
    const openings = showOpenings ? ownDoors.concat(ownWins) : [];
    const segs = wallSolidSegments(wall, openings);
    // 打印态统一用涂黑墙：木色墙在纸上印出来是脏灰，且与家具色分不开
    const color = opts.theme === 'print' ? theme.wall : (wall.color || theme.wall);
    const selected = opts.selectedWallId && opts.selectedWallId === wall.id;
    for (const [t0, t1] of segs) {
      const quad = segmentQuad(wall, t0, t1, wall.thickness);
      if (!pathPolygon(ctx, quad)) continue;
      ctx.save();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = selected ? '#58a6ff' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = (selected ? 2 : 1) / zoom;
      ctx.stroke();
      ctx.restore();
    }
    stat.walls++;

    // 门窗符号：在世界坐标里只用屏幕恒定尺寸画简单的框 + 线
    if (showOpenings) {
      const selId = opts.selectedOpeningId || null;
      for (const d of ownDoors) {
        drawOpeningSymbol(ctx, wall, d, zoom, 'door', theme);
        if (selId && d.id === selId) drawOpeningHighlight(ctx, wall, d, zoom);
        stat.doors++;
      }
      for (const w of ownWins) {
        drawOpeningSymbol(ctx, wall, w, zoom, 'window', theme);
        if (selId && w.id === selId) drawOpeningHighlight(ctx, wall, w, zoom);
        stat.windows++;
      }
    }
  }

  // ②.5 尺寸标注（2026-11-14 台账 A25）：沿墙写长度（cm→m）。
  // 白底片垫在字下面 —— 否则压在被涂黑的墙上就看不见了。
  if (opts.showDimensions !== false) {
    for (const wall of walls) {
      const len = wallLen(wall);
      if (!(len >= 20)) continue;             // 20cm 以下的碎墙不标，标了全是噪点
      const mid = wallPointAt(wall, 0.5);
      const ang = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
      // 字别倒过来：上坡角度超过 90° 就翻 180°
      const rot = Math.abs(ang) > Math.PI / 2 ? ang + Math.PI : ang;
      ctx.save();
      ctx.translate(mid.x, mid.y);
      ctx.rotate(rot);
      ctx.scale(1 / zoom, 1 / zoom);          // 屏幕恒定字号
      const label = formatLength(len);
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = theme.dimBg;
      ctx.fillRect(-tw / 2 - 3, -7, tw + 6, 13);
      ctx.fillStyle = theme.dimText;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  // ③ 转角圆盖（补墙与墙之间的缝）
  const jointMap = new Map();
  const keyOf = (p) => `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;
  for (const wall of walls) {
    for (const p of [wall.start, wall.end]) {
      const k = keyOf(p);
      const rec = jointMap.get(k);
      if (rec) {
        rec.n += 1;
        rec.thickness = Math.max(rec.thickness, Number(wall.thickness) || 0);
        rec.p = p;
      } else {
        jointMap.set(k, { n: 1, thickness: Number(wall.thickness) || 0, p });
      }
    }
  }
  ctx.save();
  for (const rec of jointMap.values()) {
    if (rec.n < 2) continue;
    ctx.beginPath();
    ctx.arc(rec.p.x, rec.p.y, Math.max(1, rec.thickness / 2), 0, Math.PI * 2);
    ctx.fillStyle = theme.joint;
    ctx.fill();
  }
  ctx.restore();

  return stat;
}

/**
 * 选中的门窗：沿墙画一个黄色框（世界坐标，墙厚 × 洞口宽）。
 * 为什么不用 DOM 浮层：画布会平移缩放，浮层要每帧跟；画在 canvas 里天然跟着走。
 */
function drawOpeningHighlight(ctx, wall, opening, zoom) {
  const t = Math.min(1, Math.max(0, Number(opening.position) || 0.5));
  const p = wallPointAt(wall, t);
  const n = wallNormal(wall);
  const half = Math.max(2, (Number(opening.width) || 60) / 2);
  const th = (Number(wall.thickness) || 12) / 2 + 3;
  const dx = (wall.end.x - wall.start.x);
  const dy = (wall.end.y - wall.start.y);
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  const quad = [
    { x: p.x + dir.x * half + n.x * th, y: p.y + dir.y * half + n.y * th },
    { x: p.x - dir.x * half + n.x * th, y: p.y - dir.y * half + n.y * th },
    { x: p.x - dir.x * half - n.x * th, y: p.y - dir.y * half - n.y * th },
    { x: p.x + dir.x * half - n.x * th, y: p.y + dir.y * half - n.y * th },
  ];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath();
  ctx.strokeStyle = '#ffb300';
  ctx.lineWidth = 2.5 / zoom;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.restore();
}

/**
 * 本层楼板上的洞口（2026-11-15，A16）：灰底 + 虚线框。
 *
 * 为什么不画"梯段剖面"：洞口可能来自下层楼梯、也可能是以后的手画洞（检修口/挑空），
 * 这里只负责表达"这块板是空的"。梯段本身由 `drawStairSymbol` 画在**所属那一层**上。
 */
export function drawFloorHoles(ctx, holes, opts = {}) {
  const zoom = Number(opts.zoom) > 0 ? Number(opts.zoom) : 1;
  const theme = opts.theme || floorTheme('screen');
  for (const h of holes || []) {
    const poly = Array.isArray(h) ? h : (h && h.poly);
    if (!pathPolygon(ctx, poly)) continue;
    ctx.save();
    ctx.fillStyle = theme.holeFill;
    ctx.fill();
    ctx.setLineDash([8 / zoom, 5 / zoom]);
    ctx.strokeStyle = theme.holeLine;
    ctx.lineWidth = 1.4 / zoom;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 一部楼梯的平面符号（2026-11-15，A24）：梯段矩形 + 踏步线 + 上下行箭头 + 「上/下」。
 *
 * 踏步数与踏面位置全部来自 `stairs.js`（与 3D 同一份几何）—— 这里只画，不算。
 * 尺寸口径与墙一致：线宽/字号按 zoom 反算，缩放到哪一级都是同一个视觉厚度。
 */
export function drawStairSymbol(ctx, stair, opts = {}) {
  const zoom = Number(opts.zoom) > 0 ? Number(opts.zoom) : 1;
  const theme = opts.theme || floorTheme('screen');
  const g = stairTreads(stair, {
    ownElevation: opts.ownElevation,
    targetElevation: opts.targetElevation,
  });
  const fp = stairFootprint(stair);
  const axis = fp.axis;
  const half = fp.halfWidth;
  const nx = -axis.dy;
  const ny = axis.dx;

  // ① 梯段底
  if (pathPolygon(ctx, fp.poly)) {
    ctx.save();
    ctx.fillStyle = theme.stairFill;
    ctx.fill();
    ctx.strokeStyle = opts.selected ? '#ffb300' : theme.stairLine;
    ctx.lineWidth = (opts.selected ? 2.2 : 1.4) / zoom;
    ctx.stroke();
    ctx.restore();
  }

  // ② 踏步线：n-1 条横线（首尾是梯段边，不重复画）
  ctx.save();
  ctx.strokeStyle = theme.stairLine;
  ctx.lineWidth = 1.1 / zoom;
  ctx.beginPath();
  for (let i = 1; i < g.steps; i++) {
    const t = i / g.steps;
    const px = axis.x + axis.dx * axis.len * t;
    const py = axis.y + axis.dy * axis.len * t;
    ctx.moveTo(px + nx * half, py + ny * half);
    ctx.lineTo(px - nx * half, py - ny * half);
  }
  ctx.stroke();
  ctx.restore();

  // ③ 方向箭头（沿中线），箭头指向"走上去/走下去"的方向（起点 → 终点）
  const t0 = 0.12;
  const t1 = 0.84;
  const sx = axis.x + axis.dx * axis.len * t0;
  const sy = axis.y + axis.dy * axis.len * t0;
  const ex = axis.x + axis.dx * axis.len * t1;
  const ey = axis.y + axis.dy * axis.len * t1;
  const head = Math.min(14 / zoom, axis.len * 0.2);
  ctx.save();
  ctx.strokeStyle = theme.stairText;
  ctx.fillStyle = theme.stairText;
  ctx.lineWidth = 1.6 / zoom;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // 箭头两撇
  for (const sign of [1, -1]) {
    const ax = ex - axis.dx * head + nx * head * 0.6 * sign;
    const ay = ey - axis.dy * head + ny * head * 0.6 * sign;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ax, ay);
    ctx.stroke();
  }
  // ④「上 / 下」：写在箭头起点一侧，屏幕恒定字号（缩放后仍读得出）
  const dir = stairDirection(stair);
  const label = dir === 'down' ? '下' : '上';
  ctx.save();
  ctx.translate(sx - axis.dx * (12 / zoom), sy - axis.dy * (12 / zoom));
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.font = '12px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeText(label, 0, 0);
  ctx.fillText(label, 0, 0);
  ctx.restore();
  ctx.restore();
}

/** 门窗符号：在墙上挖开的缺口里画几笔（屏幕恒定线宽） */
function drawOpeningSymbol(ctx, wall, opening, zoom, kind, theme = floorTheme('screen')) {
  const t = Math.min(1, Math.max(0, Number(opening.position) || 0.5));
  const p = wallPointAt(wall, t);
  const n = wallNormal(wall);
  const half = Math.max(2, (Number(opening.width) || 60) / 2);
  const a = { x: p.x + n.x * (Number(wall.thickness) || 12) / 2, y: p.y + n.y * (Number(wall.thickness) || 12) / 2 };
  const b = { x: p.x - n.x * (Number(wall.thickness) || 12) / 2, y: p.y - n.y * (Number(wall.thickness) || 12) / 2 };
  const dir = { x: (wall.end.x - wall.start.x) / (Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1),
    y: (wall.end.y - wall.start.y) / (Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1) };
  const jambA = { x: a.x - dir.x * half, y: a.y - dir.y * half };
  const jambB = { x: a.x + dir.x * half, y: a.y + dir.y * half };

  ctx.save();
  ctx.strokeStyle = kind === 'door' ? theme.door : theme.window;
  ctx.lineWidth = 2.2 / zoom;
  ctx.beginPath();
  ctx.moveTo(jambA.x, jambA.y);
  ctx.lineTo(jambB.x, jambB.y);
  ctx.stroke();
  if (kind === 'window') {
    // 窗：两道平行细线（沿墙方向）
    ctx.beginPath();
    ctx.moveTo(jambA.x - n.x * (Number(wall.thickness) || 12) * 0.34, jambA.y - n.y * (Number(wall.thickness) || 12) * 0.34);
    ctx.lineTo(jambB.x - n.x * (Number(wall.thickness) || 12) * 0.34, jambB.y - n.y * (Number(wall.thickness) || 12) * 0.34);
    ctx.stroke();
  } else {
    // 门：门扇 + 开合弧
    const leaf = { x: jambA.x + n.x * half, y: jambA.y + n.y * half };
    ctx.beginPath();
    ctx.moveTo(jambA.x, jambA.y);
    ctx.lineTo(leaf.x, leaf.y);
    ctx.stroke();
    const ang0 = Math.atan2(jambA.y - p.y, jambA.x - p.x);
    const ang1 = Math.atan2(leaf.y - p.y, leaf.x - p.x);
    ctx.beginPath();
    ctx.arc(p.x, p.y, half, Math.min(ang0, ang1), Math.max(ang0, ang1));
    ctx.globalAlpha = 0.5;
    ctx.stroke();
  }
  ctx.restore();
  void b;
}
