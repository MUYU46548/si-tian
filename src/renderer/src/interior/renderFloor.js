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

import { formatArea } from '../utils/interiorUnits';
import { getRoomPolygon, polygonArea } from '../utils/roomDetection';

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
  },
  print: {
    roomFill: '#eef1f5',
    roomStroke: '#c5ced8',
    roomText: '#2f3742',
    roomTextHalo: 'rgba(255,255,255,0.92)',
    wall: '#3e4348',            // 平面图里墙是"涂黑"的（poche），不跟屏幕的棕色
    wallStroke: 'rgba(0,0,0,0.55)',
    joint: '#3e4348',
    door: '#8a6d3b',
    window: '#3f7391',
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
 * @param {string} [opts.selectedWallId]
 * @returns {{walls:number, rooms:number, doors:number, windows:number}} 实际画了多少
 */
export function drawInteriorFloor(ctx, floor, opts = {}) {
  const zoom = Number(opts.zoom) > 0 ? Number(opts.zoom) : 1;
  const theme = floorTheme(opts.theme);
  const walls = Array.isArray(floor && floor.walls) ? floor.walls : [];
  const rooms = Array.isArray(floor && floor.rooms) ? floor.rooms : [];
  const doors = Array.isArray(floor && floor.doors) ? floor.doors : [];
  const windows = Array.isArray(floor && floor.windows) ? floor.windows : [];
  const showRooms = opts.showRooms !== false;
  const showLabels = opts.showLabels !== false;
  const showOpenings = opts.showOpenings !== false;
  const stat = { walls: 0, rooms: 0, doors: 0, windows: 0 };

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
      for (const d of ownDoors) {
        drawOpeningSymbol(ctx, wall, d, zoom, 'door', theme);
        stat.doors++;
      }
      for (const w of ownWins) {
        drawOpeningSymbol(ctx, wall, w, zoom, 'window', theme);
        stat.windows++;
      }
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
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  ctx.moveTo(jambA.x, jambA.y);
  ctx.lineTo(jambB.x, jambB.y);
  ctx.stroke();
  if (kind === 'window') {
    // 窗：两道平行细线（沿墙方向）
    ctx.beginPath();
    ctx.moveTo(jambA.x - n.x * (Number(wall.thickness) || 12) * 0.25, jambA.y - n.y * (Number(wall.thickness) || 12) * 0.25);
    ctx.lineTo(jambB.x - n.x * (Number(wall.thickness) || 12) * 0.25, jambB.y - n.y * (Number(wall.thickness) || 12) * 0.25);
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
