// galaxy/domainPaint.js —— 星域领土的**唯一画法**（画布 / 导出 PNG 共用）
//
// 2026-11-02 起因：边界从凸包换成所有权场软轮廓后，画布与导出**必须继续同源**
// （`test_117` 的源码闸门 + 像素判据守的就是「导出的图和屏幕上的不是一回事」）。
// 旧实现在两处各写一遍（GalaxyMap 里三段 stroke + 导出里一段），改一处另两处不变 —— 这正是不许再出现的形态。
//
// 画法口径（对得上 SP-1025 `render/regions.ts`）：
//   · 填充不是纯色，是**径向渐隐**（腹地浓 0.30 / 中段 0.16 / 边界 0.05）→ 色块融进未探索区；
//   · 描边是**细线 + 一层柔光底衬**，不是粗白边（粗边会把相邻星域割成两块贴纸）；
//   · 星域名是**无底框墨字**，字色取势力色（EU4 口径，见 `refs/MANIFEST.md`）；
//   · 所有线宽/字号一律「屏幕像素 ÷ scale」（导出态用 uiScale），缩放不变粗。

/** 任意 CSS 颜色 → rgba（`getFactionColor` 对表外势力返回 `hsl(...)`，不能只认 6 位 hex） */
export function toRgb(color) {
  const c = String(color || '#888888').trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    if (hex.length === 8) hex = hex.slice(0, 6);
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n)) return { r: 136, g: 136, b: 136 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
  }
  const hsl = c.match(/^hsla?\(([^)]+)\)$/i);
  if (hsl) {
    const parts = hsl[1].split(/[,/\s]+/).filter(Boolean);
    return hslToRgb(parseFloat(parts[0]) / 360, parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100);
  }
  return { r: 136, g: 136, b: 136 };
}

/** 任意 CSS 颜色 → rgba（`getFactionColor` 对表外势力返回 `hsl(...)`，不能只认 6 位 hex） */
export function toRgba(color, alpha = 1) {
  const { r, g, b } = toRgb(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 向某个中性色去饱和（t = 0..1） */
function mixToward(color, target, t) {
  const { r, g, b } = toRgb(color);
  const m = (a, n) => Math.round(a * (1 - t) + n * t);
  return `rgb(${m(r, target[0])},${m(g, target[1])},${m(b, target[2])})`;
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
  };
}

/** 一个 border 的全部环（软轮廓可能多环：飞地 / 洞） */
function loopsOf(border) {
  if (Array.isArray(border.loops) && border.loops.length) return border.loops;
  return border.points && border.points.length >= 3 ? [border.points] : [];
}

function traceLoops(ctx, loops) {
  ctx.beginPath();
  for (const loop of loops) {
    if (!loop || loop.length < 3) continue;
    ctx.moveTo(loop[0].x, loop[0].y);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
    ctx.closePath();
  }
}

/**
 * 画全部星域领土（填充 + 边界 + 名字）。
 * @param {CanvasRenderingContext2D} ctx 已带世界变换
 * @param {Array} borders `factionBorders()` 的返回
 * @param {{scale?:number, exportMode?:boolean, uiScale?:number, isDark?:boolean, lod?:number,
 *          editingId?:string|null, hoveredId?:string|null, labelAlpha?:number, drawLabels?:boolean}} opts
 */
export function paintDomainBorders(ctx, borders, opts = {}) {
  const {
    scale = 1,
    exportMode = false,
    uiScale = 1,
    isDark = true,
    lod = 1,
    editingId = null,
    hoveredId = null,
    labelAlpha = 1,
    drawLabels = true,
  } = opts;
  if (!Array.isArray(borders) || !borders.length) return;

  // 1 屏幕像素 = 多少世界单位
  const unit = exportMode ? uiScale : 1 / Math.max(0.0001, scale);

  for (const border of borders) {
    const loops = loopsOf(border);
    if (!loops.length) continue;
    const isEditing = editingId != null && border.domainId === editingId;
    const isHovered = hoveredId != null && border.domainId === hoveredId;
    const boost = isEditing ? 0.1 : isHovered ? 0.05 : 0;

    // ── 填充：径向渐隐（中心浓、边淡）──
    ctx.save();
    traceLoops(ctx, loops);
    const cx = border.center ? border.center.x : loops[0][0].x;
    const cy = border.center ? border.center.y : loops[0][0].y;
    const rOuter = border.fadeRadius || 360;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rOuter);
    const base = isDark ? 1 : 0.62;
    // 色块是**一层淡淡的归属水洗**，不是实心领土：0.34 在近景会把整屏糊成一片紫雾（实测踩过）。
    // 同时向蓝灰去饱和 16%（原型 `regions.ts` 的 NEUTRAL 混色），免得三个势力色互相打架。
    const fillColor = mixToward(border.color, [168, 182, 210], 0.16);
    g.addColorStop(0, toRgba(fillColor, Math.min(1, (0.21 + boost) * base)));
    g.addColorStop(0.7, toRgba(fillColor, Math.min(1, (0.15 + boost) * base)));
    g.addColorStop(1, toRgba(fillColor, Math.min(1, 0.075 * base)));
    ctx.fillStyle = g;
    // 远景色块不该发光抢星点（原型：远景区块只是"一片淡淡的地")
    if (!exportMode && isDark && lod > 0.45) {
      ctx.shadowColor = toRgba(border.color, 0.5);
      ctx.shadowBlur = (isEditing ? 34 : 20) * unit * (exportMode ? 1 : 0.6);
    }
    ctx.fill();
    ctx.restore();

    // ── 边界：柔光底衬 + 细线（粗白边会把相邻星域割成两块贴纸）──
    const lineAlpha = (isEditing ? 0.85 : isHovered ? 0.7 : 0.5) + (lod < 0.4 ? -0.1 : 0);
    ctx.save();
    traceLoops(ctx, loops);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = toRgba(border.color, Math.max(0.05, lineAlpha * 0.36));
    ctx.lineWidth = (isEditing ? 10 : 7) * unit;
    ctx.stroke();
    ctx.strokeStyle = toRgba(border.color, Math.max(0.08, lineAlpha));
    ctx.lineWidth = (isEditing ? 2.4 : 1.6) * unit;
    ctx.stroke();
    ctx.restore();

    // ── 星域名：无底框墨字（深底描边，亮字取势力色）──
    if (!drawLabels || labelAlpha <= 0.02) continue;
    // 名字要不要出现，按**色块在屏幕上的半径**判（不是按整幅图的 scale）：
    // 缩到全图时 scale≈0.36，旧口径 `lod>0.4` 会让整幅图一个星域名都没有（用户看到的是「四个无名色块」）。
    const pxRadius = (border.fadeRadius || 360) * (exportMode ? 1 : scale);
    if (exportMode ? false : pxRadius < 26) continue;
    const fontPx = exportMode ? 17 * uiScale : Math.max(10, Math.min(19, pxRadius / 5.2));
    const fontSize = exportMode ? fontPx : fontPx * unit;
    ctx.save();
    ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = isDark ? 'rgba(4, 7, 14, 0.78)' : 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = (exportMode ? 3.2 * uiScale : 3.2 * unit) * Math.max(0.55, Math.min(1, fontPx / 16));
    ctx.globalAlpha = labelAlpha * (exportMode ? 1 : Math.min(1, Math.max(0.88, lod * 0.9 + 0.6)));
    ctx.strokeText(border.name || '', cx, cy);
    // 字色向白提亮 42%：势力色原样用在深底上，紫/蓝这类颜色几乎读不出来（第一版实测：四个名字全是暗块）
    ctx.fillStyle = toRgba(mixToward(border.color, [255, 255, 255], 0.42), 0.95);
    ctx.fillText(border.name || '', cx, cy);
    ctx.restore();
  }
}
