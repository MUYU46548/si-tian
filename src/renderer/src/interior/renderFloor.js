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
import { columnFootprint } from './columns.js';
import {
  normalizeFloorTexture, normalizeCeiling, ceilingTextureOf,
  floorPatternSegments, floorPatternStyle,
  floorTextureCss, floorTextureLineCss,
} from './floorPatterns.js';
import { insetPolygon } from './triangulate.js';

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
    // 柱：实心填充 + 对角交叉线（建筑图里柱子的常见画法，一眼与家具块区分）
    columnFill: '#8d7f6e',
    columnLine: 'rgba(0,0,0,0.5)',
    columnCross: 'rgba(255,255,255,0.5)',
    holeFill: 'rgba(120, 120, 130, 0.10)',
    holeLine: 'rgba(110, 110, 125, 0.55)',
    dimText: '#9fb0c0',
    dimBg: 'rgba(20, 24, 32, 0.72)',
    // 吊顶注记（A15）：虚线框 + 副标题。深底用浅青，白纸用深青（各自压得住底色）
    ceilingLine: 'rgba(150, 200, 220, 0.75)',
    ceilingText: '#a9c6d6',
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
    columnFill: '#2f343b',
    columnLine: '#2f343b',
    columnCross: 'rgba(255,255,255,0.7)',
    holeFill: 'rgba(90, 95, 105, 0.07)',
    holeLine: 'rgba(70, 75, 85, 0.45)',
    dimText: '#6b7783',
    dimBg: 'rgba(255,255,255,0.86)',
    ceilingLine: 'rgba(70, 120, 140, 0.7)',
    ceilingText: '#436472',
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
 * 房间包围盒（纹理铺设范围；纹理线会再被裁进房间多边形里）
 */
function polyBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 房间地面（2026-11-15，A23）：**用户自选色 > 材质纹理 > 主题纯色**。
 *
 * 自己管路径（先 fill 底色，再 clip 画纹理线，最后把多边形路径重新建回来）——
 * `ctx.clip()` 会吃掉当前路径，不重建的话调用方的描边会画到纹理线上去。
 *
 * @returns {string} 实际用到的材质 id（`none` = 纯色）
 */
function paintRoomFloor(ctx, poly, room, { zoom, theme }) {
  const texId = normalizeFloorTexture(room && room.floorTexture);
  const custom = room && room.color;
  if (!pathPolygon(ctx, poly)) return texId;
  if (custom) { ctx.fillStyle = custom; ctx.fill(); return texId; }

  const base = floorTextureCss(texId, theme);
  if (base) {
    ctx.fillStyle = base;
    ctx.fill();
    const segs = floorPatternSegments(texId, polyBounds(poly));
    if (segs.length) {
      const st = floorPatternStyle(texId, theme);
      ctx.save();
      ctx.clip();                       // 裁进房间：矩形房间之外的部分不画
      ctx.beginPath();
      for (const s of segs) { ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); }
      ctx.globalAlpha = st.alpha;
      ctx.strokeStyle = floorTextureLineCss(texId, theme);
      ctx.lineWidth = st.widthPx / zoom;
      ctx.stroke();
      ctx.restore();
    }
    return texId;
  }

  ctx.fillStyle = theme.roomFill;
  ctx.fill();
  return texId;
}

/**
 * 吊顶虚线框（2026-11-15，A15）：沿房间内缩一圈画虚线。
 * 为什么是虚线 + 内缩：实线贴墙会和墙线混成一条，内缩一圈才读得出"这是吊顶范围"。
 */
function strokeCeilingOutline(ctx, poly, { zoom, theme }) {
  const ins = insetPolygon(poly, 14);
  if (ins.length < 3 || !pathPolygon(ctx, ins)) return false;
  ctx.save();
  ctx.setLineDash([7 / zoom, 5 / zoom]);
  ctx.strokeStyle = theme.ceilingLine;
  ctx.lineWidth = 0.9 / zoom;
  ctx.stroke();
  ctx.restore();
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
  const stat = { walls: 0, rooms: 0, doors: 0, windows: 0, stairs: 0, columns: 0 };

  // ① 房间（墙下面那层）
  if (showRooms && rooms.length) {
    for (const room of rooms) {
      const poly = getRoomPolygon(room, walls);
      if (poly.length < 3) continue;
      const isSel = !!opts.selectedRoomId && opts.selectedRoomId === room.id;
      const ceil = normalizeCeiling(room.ceiling);
      ctx.save();
      // 地面材质（A23）自己管路径；回来之后必须重新建一次多边形路径再描边
      paintRoomFloor(ctx, poly, room, { zoom, theme });
      if (!pathPolygon(ctx, poly)) { ctx.restore(); continue; }
      // 选中房间（A29）：叠一层亮色 + 亮描边 —— 只靠描边在浅色纸上看不清“选中的是哪一间”
      if (isSel) {
        ctx.fillStyle = 'rgba(88, 166, 255, 0.22)';
        ctx.fill();
      }
      ctx.strokeStyle = isSel ? '#58a6ff' : (room.color || theme.roomStroke);
      ctx.lineWidth = (isSel ? 2.6 : 1) / zoom;
      ctx.stroke();
      // 吊顶范围（A15）：虚线压在最上层，才不会被地面纹理吃掉
      if (ceil) strokeCeilingOutline(ctx, poly, { zoom, theme });
      ctx.restore();
      stat.rooms++;
      if (ceil) stat.ceilingRooms = (stat.ceilingRooms || 0) + 1;

      if (showLabels) {
        const area = polygonArea(poly);
        const label = room.name ? `${room.name}  ${formatArea(area)}` : formatArea(area);
        const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
        const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1 / zoom, 1 / zoom);          // 字号按屏幕像素给
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 深色底 + 浅色字，描边保证压在任何底色上都读得出
        ctx.font = '13px "Microsoft YaHei", sans-serif';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = theme.roomTextHalo;
        ctx.strokeText(label, 0, 0);
        ctx.fillStyle = theme.roomText;
        ctx.fillText(label, 0, 0);
        // 吊顶副标题（A15）：材质名 + 净高。
        // 位置**放在房间内缩矩形的左上角**，不进房间名那一行 ——
        // 第一版接在面积下面（两行只隔 4px），第二版改到上方仍然和名字挤成一团；
        // 平面图里这种注记本来就该贴墙角，不抢中心那行"房间名 · 面积"。
        if (ceil) {
          const sub = `${ceilingTextureOf(ceil.texture).label}吊顶 ${formatLength(ceil.height)}`;
          const ins = insetPolygon(poly, 26);
          const box = polyBounds(ins.length >= 3 ? ins : poly);
          ctx.save();
          ctx.translate(box.minX + 8, box.minY + 8);
          ctx.scale(1 / zoom, 1 / zoom);
          ctx.font = '11px "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.lineWidth = 3;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = theme.roomTextHalo;
          ctx.strokeText(sub, 0, 0);
          ctx.fillStyle = theme.ceilingText;
          ctx.fillText(sub, 0, 0);
          ctx.restore();
        }
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
    const selected = (opts.selectedWallId && opts.selectedWallId === wall.id)
      || (Array.isArray(opts.selectedWallIds) && opts.selectedWallIds.includes(wall.id));
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

  // ②.2 柱（2026-11-15，A24 余）：压在墙上画 —— 柱是墙里的竖向构件，
  // 画在墙下面会被涂黑的墙线整根盖掉（打印态尤其明显）。
  if (opts.showColumns !== false) {
    const cols = Array.isArray(floor && floor.columns) ? floor.columns : [];
    for (const col of cols) {
      if (!col) continue;
      drawColumnSymbol(ctx, col, {
        zoom,
        theme,
        selected: !!opts.selectedColumnId && opts.selectedColumnId === col.id,
      });
      stat.columns++;
    }
  }

  // ②.5 尺寸标注（2026-11-14 台账 A25）：沿墙写长度（cm→m）。
  //
  // 🔴 2026-11-15（暮雨看平面图抓出来）：字原来压在墙中心线上 —— 打印态的墙是涂黑的（poche），
  //    白底片盖不住整条墙，读起来像"墙上有字"。改成**贴到墙的外侧**（离墙皮 9cm）：
  //    外墙的尺寸写在外面，是制图的基本规矩；内墙（两侧都是房间）则写到远离建筑中心那一侧。
  if (opts.showDimensions !== false && walls.length) {
    // 建筑中心：所有墙端点的平均（够用，且不引入包围盒那种 L 形失效）
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const w of walls) {
      for (const p of [w.start, w.end]) {
        if (!p) continue;
        cx += p.x; cy += p.y; n++;
      }
    }
    if (n) { cx /= n; cy /= n; }
    for (const wall of walls) {
      const len = wallLen(wall);
      if (!(len >= 20)) continue;             // 20cm 以下的碎墙不标，标了全是噪点
      const mid = wallPointAt(wall, 0.5);
      const ang = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
      // 字别倒过来：上坡角度超过 90° 就翻 180°
      const rot = Math.abs(ang) > Math.PI / 2 ? ang + Math.PI : ang;
      const nrm = wallNormal(wall);
      // "外侧" = 法向背离建筑中心的那一侧（法向与"中心→墙中点"同向就取正）
      const sign = (nrm.x * (mid.x - cx) + nrm.y * (mid.y - cy)) >= 0 ? 1 : -1;
      const off = Math.max(1, Number(wall.thickness) || 12) / 2 + 9;   // 墙皮外 9cm
      ctx.save();
      ctx.translate(mid.x + nrm.x * off * sign, mid.y + nrm.y * off * sign);
      ctx.rotate(rot);
      ctx.scale(1 / zoom, 1 / zoom);          // 屏幕恒定字号
      const label = formatLength(len);
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      // 白底片：标注移出墙体后仍要能在家具/填充上读出来
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
  const list = holes || [];
  for (const h of list) {
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
  // 洞不写字就是一块"没解释的虚线框"（用户只会问"这虚线是什么"）。
  // 只在洞够大时标，免得小洞上糊一片字。
  if (!list.length || opts.showHoleLabels === false) return;
  for (const h of list) {
    const poly = Array.isArray(h) ? h : (h && h.poly);
    if (!poly || poly.length < 3) continue;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if ((maxX - minX) * zoom < 40 || (maxY - minY) * zoom < 30) continue;   // 屏幕上太小就不标
    const dir = h && h.direction === 'down' ? '下' : '上';
    // 手画的洞（检修口 / 挑空）没有 direction：标签用它自己的名字，别写成“楼梯洞口”
    const text = (h && h.holeId) ? String(h.label || '洞口') : `楼梯洞口（${dir}）`;
    ctx.save();
    ctx.translate((minX + maxX) / 2, (minY + maxY) / 2);
    ctx.scale(1 / zoom, 1 / zoom);          // 之后都是屏幕像素单位（字号不随缩放变大）
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    // 🔴 白底片垫底，不用 strokeText 描边：10px 的字配 3px 描边会把笔画糊成一团
    //    （2026-11-15 二层留证图上亲眼看到洞口标签糊成一坨灰，改为与尺寸标注同一套写法）。
    ctx.fillStyle = theme.dimBg;
    ctx.fillRect(-tw / 2 - 4, -9, tw + 8, 18);
    ctx.fillStyle = theme.dimText;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

/**
 * 一根柱的平面符号（2026-11-15，A24 余）：实心方 + 对角交叉线 + 选中高亮。
 *
 * 为什么带交叉线而不是纯色块：家具也是纯色块，并排时分不清“这是柱还是柜子”；
 * 建筑图里柱子本来就常画成带对角线的实心矩形，读图的人一眼认得。
 */
export function drawColumnSymbol(ctx, col, opts = {}) {
  const fp = columnFootprint(col);
  if (!fp) return;
  const zoom = Number(opts.zoom) > 0 ? Number(opts.zoom) : 1;
  const theme = opts.theme || floorTheme('screen');
  ctx.save();
  ctx.fillStyle = theme.columnFill;
  ctx.fillRect(fp.x, fp.y, fp.w, fp.h);
  // 对角交叉线（屏幕恒定线宽：缩到哪一级都一样细）
  ctx.strokeStyle = theme.columnCross;
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  ctx.moveTo(fp.x, fp.y); ctx.lineTo(fp.x + fp.w, fp.y + fp.h);
  ctx.moveTo(fp.x + fp.w, fp.y); ctx.lineTo(fp.x, fp.y + fp.h);
  ctx.stroke();
  // 外框：选中时加粗高亮
  ctx.strokeStyle = opts.selected ? '#58a6ff' : theme.columnLine;
  ctx.lineWidth = (opts.selected ? 2.4 : 1.2) / zoom;
  ctx.strokeRect(fp.x, fp.y, fp.w, fp.h);
  ctx.restore();
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

/**
 * 门的开合几何（2026-11-15，A12）：铰点 + 门扇 + 90° 弧。
 *
 * 旧画法的错：圆心放在**洞口中心**、半径只取**半个洞口** —— 弧从门扇中点扫起，
 * 图上看起来像“半个门”，与制图习惯（铰点在门框一端、门扇长 = 洞口宽、弧扫 90°）对不上。
 *
 * 口径：
 *   · 铰点 `hinge` 默认在洞口**起点端**（沿墙方向的 start 侧）；`opening.swingDirection === 'right'` 换到另一端；
 *   · 门扇长 = 洞口宽，画在**开启位置**（垂直墙面）；
 *   · 弧圆心 = 铰点、半径 = 洞口宽，从墙线（关闭位置）扫到门扇（开启位置），正好 90°；
 *   · `opening.flipSide === true` 让门扇开向墙的另一侧（默认开向墙的左法向）。
 *
 * ⚠️ 字段用的是 `store.addOpening` 早就在写的 `swingDirection` / `flipSide` ——
 *    不另起一套 `hinge` / `swing`，否则同一件事两套命名，改一处另一处不动。
 *
 * @param {object} wall  { start, end, thickness }
 * @param {object} opening { position, width, swingDirection?, flipSide? }
 * @returns {{hinge:object, other:object, leaf:object, radius:number, width:number,
 *            normal:object, angStart:number, angEnd:number, delta:number,
 *            jambA:object, jambB:object, center:object, dir:object}}
 */
export function doorSwingGeometry(wall, opening) {
  const width = Math.max(2, Number(opening && opening.width) || 90);
  const t = Math.min(1, Math.max(0, Number(opening && opening.position) || 0.5));
  const center = wallPointAt(wall, t);
  const n = wallNormal(wall);
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1;
  const dir = { x: (wall.end.x - wall.start.x) / len, y: (wall.end.y - wall.start.y) / len };
  const half = width / 2;
  const jambA = { x: center.x - dir.x * half, y: center.y - dir.y * half };
  const jambB = { x: center.x + dir.x * half, y: center.y + dir.y * half };
  const hingeAtStart = !opening || opening.swingDirection !== 'right';
  const hinge = hingeAtStart ? jambA : jambB;
  const other = hingeAtStart ? jambB : jambA;
  const swingSign = opening && opening.flipSide ? -1 : 1;
  const normal = { x: n.x * swingSign, y: n.y * swingSign };
  const leaf = { x: hinge.x + normal.x * width, y: hinge.y + normal.y * width };
  const angStart = Math.atan2(other.y - hinge.y, other.x - hinge.x);   // 关闭位置（沿墙指向另一侧门框）
  const angLeaf = Math.atan2(normal.y, normal.x);                      // 开启位置（垂直墙）
  let delta = angLeaf - angStart;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return {
    hinge, other, leaf, radius: width, width, normal,
    angStart, angEnd: angStart + delta, delta,
    jambA, jambB, center, dir,
  };
}

/** 门窗符号：在墙上挖开的缺口里画几笔（屏幕恒定线宽） */
function drawOpeningSymbol(ctx, wall, opening, zoom, kind, theme = floorTheme('screen')) {
  const g = doorSwingGeometry(wall, opening);
  const p = g.center;
  const n = wallNormal(wall);
  const half = g.width / 2;
  const thickness = Number(wall.thickness) || 12;
  const a = { x: p.x + n.x * thickness / 2, y: p.y + n.y * thickness / 2 };
  const b = { x: p.x - n.x * thickness / 2, y: p.y - n.y * thickness / 2 };
  const jambA = g.jambA;
  const jambB = g.jambB;

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
    ctx.moveTo(jambA.x - n.x * thickness * 0.34, jambA.y - n.y * thickness * 0.34);
    ctx.lineTo(jambB.x - n.x * thickness * 0.34, jambB.y - n.y * thickness * 0.34);
    ctx.stroke();
  } else {
    // 门：门扇（开启位置，长 = 洞口宽）+ 90° 开合弧（圆心 = 铰点，半径 = 洞口宽）
    ctx.beginPath();
    ctx.moveTo(g.hinge.x, g.hinge.y);
    ctx.lineTo(g.leaf.x, g.leaf.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.hinge.x, g.hinge.y, g.radius, g.angStart, g.angEnd, g.delta < 0);
    ctx.globalAlpha = 0.55;
    ctx.stroke();
  }
  ctx.restore();
  void b;
  void half;
}
