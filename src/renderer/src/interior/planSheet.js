// interior/planSheet.js — 建筑平面图「出图」（2026-11-14，第 4 刀）
//
// ── 这一层解决什么 ───────────────────────────────────────────────────────
// 之前画布上的平面图**只能看**：一屏深底、亮蓝房间、没有比例尺、没有标题，
// 截屏贴进设定集也不像一张图。这一层把同一份楼层数据排成**一张图纸**：
//   图框 / 标题栏 / 比例尺 / 指北针 / 图例 / 房间面积表 + 中间那张平面图。
//
// ── 两条硬纪律 ───────────────────────────────────────────────────────────
// 1) **不另画一遍平面图**：中间的图由调用方传进来的 `drawMap(ctx)` 画（它就是
//    `renderFloor.drawInteriorFloor` 换个 print 主题），所以出图与屏幕永远同源。
//    这一层只负责"纸、框、表、尺"。
// 2) **纯函数优先**：版式（比例、图框、表格行、比例尺刻度）全是数字计算，
//    不碰 DOM、不 import 任何模块 → Node 单测直接跑（`unit/test_plan_sheet.js`）。
//
// ── 单位口径 ─────────────────────────────────────────────────────────────
// 版式一律用 **CSS px（96dpi）**。A4 横向 = 297×210mm = 1122×794px。
// 出图时按 2 倍放大画（2244×1588），等于 192dpi —— 贴进 Word/A4 打印都够清楚。
// 世界单位仍是 cm，`pxPerCm` 把 cm 换算到纸面 px：`pxPerCm = 37.795 / 比例分母`。

/** 纸张（CSS px @96dpi） */
export const SHEET_PAPERS = Object.freeze({
  A4: { w: 1122, h: 794 },
  A3: { w: 1587, h: 1122 },
});

/** 1cm 纸面对应多少 px（96dpi / 2.54cm每英寸） */
export const PX_PER_CM_PAPER = 96 / 2.54;

/** 可选比例分母（1:50 … 1:5000）。取**能放下**的最小分母 = 最大的那张图 */
export const SCALE_DENOMS = Object.freeze([50, 100, 200, 500, 1000, 2000, 5000]);

const MARGIN = 28;
const FRAME_INSET = 18;
const HEADER_H = 44;
const TITLEBAR_H = 92;
const PANEL_W = 268;
const GAP = 16;
const MAX_TABLE_ROWS = 14;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, k = 2) {
  const p = Math.pow(10, k);
  return Math.round(v * p) / p;
}

/**
 * 选比例：在候选分母里取「平面图还能放进图框」的最小分母。
 * 放不进最小分母也放不下时，用最大分母（图会超出 → 由调用方 `overflow` 标记提示）。
 *
 * @param {{w:number,h:number}} footprint 平面尺寸（cm）
 * @param {{w:number,h:number}} area 可用图面（CSS px）
 * @param {number[]} [denoms]
 * @returns {{ denom:number, pxPerCm:number, overflow:boolean }}
 */
export function pickScale(footprint, area, denoms = SCALE_DENOMS) {
  const fw = num(footprint && footprint.w);
  const fh = num(footprint && footprint.h);
  const aw = num(area && area.w);
  const ah = num(area && area.h);
  const list = Array.isArray(denoms) && denoms.length ? denoms : SCALE_DENOMS;
  const largest = list[list.length - 1];
  if (!(fw > 0) || !(fh > 0) || !(aw > 0) || !(ah > 0)) {
    return { denom: list[0], pxPerCm: PX_PER_CM_PAPER / list[0], overflow: false };
  }
  for (const denom of list) {
    const k = PX_PER_CM_PAPER / denom;
    if (fw * k <= aw && fh * k <= ah) return { denom, pxPerCm: k, overflow: false };
  }
  return { denom: largest, pxPerCm: PX_PER_CM_PAPER / largest, overflow: true };
}

/**
 * 比例尺：选一个"整米"长度（1/2/5×10^n 米），让尺子长度落在 maxPx 的 55%~100%。
 * 返回 { cm, px, ticks:[{ cm, px, label }] } —— 刻度 0/半/整。
 */
export function scaleBarPlan(pxPerCm, maxPx = 190) {
  const k = num(pxPerCm);
  const cap = num(maxPx, 190);
  if (!(k > 0)) return { cm: 0, px: 0, ticks: [] };
  const candidates = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  let pick = candidates[0];
  for (const cm of candidates) {
    if (cm * k <= cap) pick = cm;
    else break;
  }
  const px = pick * k;
  const half = pick / 2;
  return {
    cm: pick,
    px: round(px),
    ticks: [
      { cm: 0, px: 0, label: '0' },
      { cm: half, px: round(half * k), label: `${half / 100}` },
      { cm: pick, px: round(px), label: `${pick / 100}m` },
    ],
  };
}

/**
 * 房间面积表：按面积从大到小，最多 maxRows 行，其余折成一句"另有 N 间"。
 * @param {Array<{name?:string, area:number}>} rooms area 单位 cm²
 */
export function planTableRows(rooms, opts = {}) {
  const maxRows = Math.max(1, num(opts.maxRows, MAX_TABLE_ROWS));
  const list = (Array.isArray(rooms) ? rooms : [])
    .filter((r) => r && num(r.area) > 0)
    .map((r) => ({ name: String(r.name || '').trim() || '未命名', area: num(r.area) }))
    .sort((a, b) => b.area - a.area);
  const total = list.reduce((s, r) => s + r.area, 0);
  const head = list.slice(0, maxRows).map((r) => ({
    name: r.name,
    area: r.area,
    areaText: `${(r.area / 10000).toFixed(2)} ㎡`,
  }));
  return {
    rows: head,
    more: Math.max(0, list.length - head.length),
    count: list.length,
    total,
    totalText: `${(total / 10000).toFixed(2)} ㎡`,
  };
}

/**
 * 版式：给"要印什么"，算出"每块放在哪"。
 *
 * @param {object} opts
 * @param {string} [opts.buildingName]
 * @param {string} [opts.floorName]
 * @param {{w:number,h:number}} [opts.footprint] 平面外接尺寸（cm）
 * @param {Array<{name?:string,area:number}>} [opts.rooms]
 * @param {'A4'|'A3'} [opts.paper]
 * @param {string} [opts.date] 形如 2026-11-14
 * @param {string} [opts.appName]
 * @param {string} [opts.version]
 * @param {number} [opts.scaleDenom] 指定比例分母（默认自动选）
 */
export function buildPlanSheet(opts = {}) {
  const paper = SHEET_PAPERS[opts.paper] || SHEET_PAPERS.A4;
  const frame = {
    x: MARGIN,
    y: MARGIN,
    w: paper.w - MARGIN * 2,
    h: paper.h - MARGIN * 2,
  };
  const titleBar = { x: frame.x, y: frame.y + frame.h - TITLEBAR_H, w: frame.w, h: TITLEBAR_H };
  const header = { x: frame.x, y: frame.y, w: frame.w, h: HEADER_H };

  const innerLeft = frame.x + FRAME_INSET;
  const innerRight = frame.x + frame.w - FRAME_INSET;
  const mapTop = frame.y + HEADER_H + 6;
  const mapBottom = titleBar.y - 8;
  const panel = {
    x: innerRight - PANEL_W,
    y: mapTop,
    w: PANEL_W,
    h: mapBottom - mapTop,
  };
  const map = {
    x: innerLeft,
    y: mapTop,
    w: panel.x - GAP - innerLeft,
    h: mapBottom - mapTop,
  };

  // 面积表高度**按实际行数**算（固定高度会让只有两间房时下面空一大片）；
  // 再夹在"至少 120、最多 面板 - 图例" 之间
  const table = planTableRows(opts.rooms);
  const shownRows = Math.min(table.rows.length, MAX_TABLE_ROWS) + (table.more > 0 ? 1 : 0);
  const tableH = 38 + 18 + shownRows * 18 + 40;
  const areaTable = {
    x: panel.x,
    y: panel.y,
    w: panel.w,
    h: Math.max(120, Math.min(tableH, panel.h - 176)),
  };
  const legend = {
    x: panel.x,
    y: panel.y + areaTable.h + 12,
    w: panel.w,
    h: Math.min(150, panel.h - areaTable.h - 12),
  };

  const footprint = {
    w: num(opts.footprint && opts.footprint.w),
    h: num(opts.footprint && opts.footprint.h),
  };
  // 绘图区 = 图面内缩 12px，且底部再让出 40px 给比例尺（第一版尺子压在墙上）
  const drawArea = {
    x: map.x + 12,
    y: map.y + 12,
    w: Math.max(10, map.w - 24),
    h: Math.max(10, map.h - 24 - 40),
  };
  const fitArea = { w: drawArea.w, h: drawArea.h };
  const scale = opts.scaleDenom
    ? { denom: num(opts.scaleDenom, 100), pxPerCm: PX_PER_CM_PAPER / num(opts.scaleDenom, 100), overflow: false }
    : pickScale(footprint, fitArea);

  // 平面图在图面里居中（footprint 可能是 0：空楼层）
  const drawW = footprint.w * scale.pxPerCm;
  const drawH = footprint.h * scale.pxPerCm;
  const plan = {
    x: drawArea.x + (drawArea.w - drawW) / 2,
    y: drawArea.y + (drawArea.h - drawH) / 2,
    w: drawW,
    h: drawH,
  };

  const date = String(opts.date || '');

  return {
    paper: { w: paper.w, h: paper.h },
    frame,
    header,
    map,
    drawArea,
    panel,
    areaTable,
    legend,
    titleBar,
    plan,
    pxPerCm: scale.pxPerCm,
    scaleDenom: scale.denom,
    scaleOverflow: scale.overflow,
    scaleBar: scaleBarPlan(scale.pxPerCm),
    // 指北针放**抬头行**右上（日期左侧）：图面常被墙填满，放图里必被压住
    north: { cx: frame.x + frame.w - 300, cy: frame.y + HEADER_H / 2 + 4, r: 15 },
    table,
    footer: {
      text: `${opts.appName || '司天'}${opts.version ? ' v' + opts.version : ''} · ${date}`,
    },
    title: {
      main: String(opts.buildingName || '建筑'),
      sub: String(opts.floorName || ''),
    },
    // 标题栏 6 格：楼层 / 比例 / 房间数 / 合计面积 / 日期 / 图纸
    cells: [
      { label: '楼层', value: String(opts.floorName || '—') },
      { label: '比例', value: `1:${scale.denom}` },
      { label: '房间数', value: `${table.count}` },
      { label: '合计面积', value: table.totalText },
      { label: '绘制日期', value: date || '—' },
      { label: '图纸', value: '平面图' },
    ],
    empty: !(footprint.w > 0) && !(footprint.h > 0),
  };
}

// ── 绘制 ─────────────────────────────────────────────────────────────────

function fontOf(ctx, size, weight = '400') {
  ctx.font = `${weight} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
}

/** 按宽度截断（超长加省略号）—— 房间名可能很长，别冲出表格 */
export function fitText(ctx, text, maxW) {
  const s = String(text ?? '');
  if (!ctx || !(maxW > 0)) return s;
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, Math.max(1, lo)) + '…';
}

const INK = '#20262e';
const INK_SOFT = '#4a5361';
const LINE = '#20262e';
const PAPER = '#ffffff';
const PANEL_FILL = '#f7f8fa';

/**
 * 把图纸画到 ctx 上。ctx 的坐标系必须是 **CSS px**（调用方自己 scale 2 倍）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} sheet buildPlanSheet() 的产物
 * @param {(ctx:CanvasRenderingContext2D) => void} drawMap 画中间那张平面图（世界坐标，cm）
 */
export function drawPlanSheet(ctx, sheet, drawMap) {
  if (!ctx || !sheet) return;

  // 纸
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, sheet.paper.w, sheet.paper.h);

  // 图框（双线：外粗内细）
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(sheet.frame.x, sheet.frame.y, sheet.frame.w, sheet.frame.h);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(
    sheet.frame.x + 6, sheet.frame.y + 6, sheet.frame.w - 12, sheet.frame.h - 12,
  );

  // 标题（顶部）
  ctx.fillStyle = INK;
  fontOf(ctx, 22, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const mainText = fitText(ctx, sheet.title.main, sheet.header.w - 380);
  ctx.fillText(mainText, sheet.header.x + 18, sheet.header.y + 30);
  const mainW = ctx.measureText(mainText).width;
  fontOf(ctx, 13, '400');
  ctx.fillStyle = INK_SOFT;
  // 副标题跟在主标题右边（这里原来写的是 Math.min(w, 0)，恒等于 0 → 副标题压在主标题上）
  ctx.fillText(
    fitText(ctx, sheet.title.sub, sheet.header.w - 380 - mainW),
    sheet.header.x + 18 + mainW + 12,
    sheet.header.y + 30,
  );
  // 顶栏右侧：司天 + 日期
  fontOf(ctx, 11, '400');
  ctx.textAlign = 'right';
  ctx.fillStyle = INK_SOFT;
  ctx.fillText(sheet.footer.text, sheet.frame.x + sheet.frame.w - 18, sheet.header.y + 30);

  // 图面（白底 + 细边）
  ctx.save();
  ctx.fillStyle = '#fcfcfd';
  ctx.fillRect(sheet.map.x, sheet.map.y, sheet.map.w, sheet.map.h);
  ctx.strokeStyle = '#cfd6de';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(sheet.map.x, sheet.map.y, sheet.map.w, sheet.map.h);
  ctx.restore();

  // 平面图本体：裁剪到图面内，平移到居中位置，按 pxPerCm 缩放
  ctx.save();
  ctx.beginPath();
  ctx.rect(sheet.map.x, sheet.map.y, sheet.map.w, sheet.map.h);
  ctx.clip();
  if (!sheet.empty && typeof drawMap === 'function') {
    ctx.save();
    ctx.translate(sheet.plan.x, sheet.plan.y);
    ctx.scale(sheet.pxPerCm, sheet.pxPerCm);
    drawMap(ctx);
    ctx.restore();
  }
  ctx.restore();

  if (sheet.empty) {
    ctx.fillStyle = INK_SOFT;
    fontOf(ctx, 13, '400');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('本层还没有墙', sheet.map.x + sheet.map.w / 2, sheet.map.y + sheet.map.h / 2);
  }

  // 指北针
  drawNorthArrow(ctx, sheet.north);

  // 比例尺（图面左下）
  drawScaleBar(ctx, sheet, sheet.map.x + 22, sheet.map.y + sheet.map.h - 26);

  // 右侧面板：房间面积表 + 图例
  drawAreaTable(ctx, sheet, sheet.areaTable);
  drawLegend(ctx, sheet, sheet.legend);

  // 标题栏
  drawTitleBar(ctx, sheet);

  ctx.restore();
}

function drawNorthArrow(ctx, n) {
  ctx.save();
  ctx.translate(n.cx, n.cy);
  ctx.strokeStyle = LINE;
  ctx.fillStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, n.r, 0, Math.PI * 2);
  ctx.stroke();
  // 箭头（上为北）
  ctx.beginPath();
  ctx.moveTo(0, -n.r + 4);
  ctx.lineTo(n.r * 0.34, n.r * 0.5);
  ctx.lineTo(0, n.r * 0.26);
  ctx.lineTo(-n.r * 0.34, n.r * 0.5);
  ctx.closePath();
  ctx.fill();
  fontOf(ctx, 11, '600');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', 0, -n.r - 4);
  ctx.restore();
}

function drawScaleBar(ctx, sheet, x, y) {
  const bar = sheet.scaleBar;
  if (!bar || !(bar.px > 0)) return;
  ctx.save();
  // 白底浮片（制图惯例）：图面可能被墙填满，尺子直接画上去会糊在一起
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = '#d5dbe3';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.rect(x - 8, y - 26, bar.px + 26, 48);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = LINE;
  ctx.fillStyle = LINE;
  ctx.lineWidth = 1;

  // 交替黑白段（3 段，每段 bar.px/3）
  const seg = bar.px / 3;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.rect(x + i * seg, y - 5, seg, 5);
    if (i % 2 === 0) ctx.fill();
    else ctx.stroke();
  }
  ctx.beginPath();
  ctx.rect(x, y - 5, bar.px, 5);
  ctx.stroke();

  fontOf(ctx, 10, '400');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('0', x - 2, y + 3);
  ctx.textAlign = 'center';
  ctx.fillText(bar.ticks[1].label, x + bar.px / 2, y + 3);
  ctx.textAlign = 'right';
  ctx.fillText(bar.ticks[2].label, x + bar.px + 2, y + 3);

  // 比例文字
  fontOf(ctx, 10, '600');
  ctx.textAlign = 'left';
  ctx.fillText(`1:${sheet.scaleDenom}`, x, y - 20);
  ctx.restore();
}

function drawAreaTable(ctx, sheet, box) {
  const t = sheet.table;
  ctx.save();
  ctx.fillStyle = PANEL_FILL;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = '#cfd6de';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  ctx.fillStyle = INK;
  fontOf(ctx, 12, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('房间面积表', box.x + 10, box.y + 16);

  const rowH = 18;
  let y = box.y + 38;
  // 表头
  fontOf(ctx, 10, '600');
  ctx.fillStyle = INK_SOFT;
  ctx.fillText('名称', box.x + 10, y);
  ctx.textAlign = 'right';
  ctx.fillText('面积', box.x + box.w - 10, y);
  ctx.strokeStyle = '#dde3ea';
  ctx.beginPath();
  ctx.moveTo(box.x + 8, y + 9);
  ctx.lineTo(box.x + box.w - 8, y + 9);
  ctx.stroke();
  y += rowH;

  ctx.textAlign = 'left';
  fontOf(ctx, 11, '400');
  const maxRows = Math.floor((box.h - 76) / rowH);
  for (let i = 0; i < t.rows.length && i < maxRows; i++) {
    const r = t.rows[i];
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, r.name, box.w - 78), box.x + 10, y);
    ctx.textAlign = 'right';
    ctx.fillText(r.areaText, box.x + box.w - 10, y);
    y += rowH;
  }
  if (t.more > 0) {
    ctx.fillStyle = INK_SOFT;
    fontOf(ctx, 10, '400');
    ctx.textAlign = 'left';
    ctx.fillText(`另有 ${t.more} 间未列出`, box.x + 10, y);
    y += rowH;
  }

  // 合计
  ctx.strokeStyle = '#dde3ea';
  ctx.beginPath();
  ctx.moveTo(box.x + 8, box.y + box.h - 22);
  ctx.lineTo(box.x + box.w - 8, box.y + box.h - 22);
  ctx.stroke();
  fontOf(ctx, 11, '600');
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.fillText(`合计 ${t.count} 间`, box.x + 10, box.y + box.h - 10);
  ctx.textAlign = 'right';
  ctx.fillText(t.totalText, box.x + box.w - 10, box.y + box.h - 10);
  ctx.restore();
}

function drawLegend(ctx, sheet, box) {
  if (box.h < 60) return;
  ctx.save();
  ctx.fillStyle = PANEL_FILL;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = '#cfd6de';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  ctx.fillStyle = INK;
  fontOf(ctx, 12, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('图例', box.x + 10, box.y + 16);

  const items = [
    { kind: 'wall', label: '墙体' },
    { kind: 'door', label: '门' },
    { kind: 'window', label: '窗' },
    { kind: 'room', label: '房间' },
  ];
  let y = box.y + 40;
  for (const it of items) {
    const x = box.x + 14;
    ctx.save();
    if (it.kind === 'wall') {
      ctx.fillStyle = '#3e4348';
      ctx.fillRect(x, y - 5, 22, 10);
    } else if (it.kind === 'room') {
      ctx.fillStyle = '#eef1f5';
      ctx.fillRect(x, y - 5, 22, 10);
      ctx.strokeStyle = '#c5ced8';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(x, y - 5, 22, 10);
    } else if (it.kind === 'window') {
      ctx.strokeStyle = '#3f7391';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y - 3); ctx.lineTo(x + 22, y - 3);
      ctx.moveTo(x, y + 3); ctx.lineTo(x + 22, y + 3);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#8a6d3b';
      ctx.lineWidth = 1.4;
      // 与图上一致：横门扇 + 从铰点扫出四分之一弧
      ctx.beginPath();
      ctx.moveTo(x, y + 4); ctx.lineTo(x + 14, y + 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y + 4);
      ctx.arc(x, y + 4, 12, 0, -Math.PI / 2, true);
      ctx.stroke();
    }
    ctx.restore();
    fontOf(ctx, 11, '400');
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.label, x + 32, y);
    y += 22;
  }
  ctx.restore();
}

function drawTitleBar(ctx, sheet) {
  const b = sheet.titleBar;
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(b.x, b.y, b.w, b.h);

  const cells = sheet.cells || [];
  const cellW = b.w / Math.max(1, cells.length);
  for (let i = 0; i < cells.length; i++) {
    const cx = b.x + i * cellW;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(cx, b.y);
      ctx.lineTo(cx, b.y + b.h);
      ctx.strokeStyle = '#cfd6de';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    fontOf(ctx, 10, '400');
    ctx.fillStyle = INK_SOFT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(cells[i].label, cx + 10, b.y + 14);
    fontOf(ctx, 15, '600');
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, cells[i].value, cellW - 20), cx + 10, b.y + 34);
  }

  // 图名（大）放标题栏左侧之上？—— 图名在顶栏，这里只放"图纸类型"水印
  fontOf(ctx, 10, '400');
  ctx.fillStyle = '#8b95a3';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('SITIAN FLOOR PLAN', b.x + b.w - 12, b.y + b.h - 8);
  ctx.restore();
}
