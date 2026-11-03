// galaxy/domainPaint.js —— 星域领土的**唯一画法**（画布 / 导出 PNG 共用）
//
// 2026-11-02 起因：边界从凸包换成所有权场软轮廓后，画布与导出**必须继续同源**
// （`test_117` 的源码闸门 + 像素判据守的就是“导出的图和屏幕上的不是一回事”）。
// 旧实现在两处各写一遍（GalaxyMap 里三段 stroke + 导出里一段），改一处另两处不变 —— 这正是不许再出现的形态。
//
// 画法口径（对得上 SP-1025 `render/regions.ts`）：
//   · 填充不是纯色，是**径向渐隐**（腹地浓 0.30 / 中段 0.16 / 边界 0.05）→ 色块融进未探索区；
//   · 描边是**细线 + 一层柔光底衬**，不是粗白边（粗边会把相邻星域割成两块贴纸）；
//   · 星域名是**无底框墨字**，字色取势力色（EU4 口径，见 `refs/MANIFEST.md`）；
//   · 所有线宽/字号一律“屏幕像素 ÷ scale”（导出态用 uiScale），缩放不变粗。

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

    // ── 填充：**近黑的半透明底**（2026-11-02 按群星参考图改口径）──
    // 旧做法是“径向渐隐、中心最亮”——那是把领土画成一片发光的雾；
    // 群星（`refs/src/星域视图2.jpg` / `星域视图4.png`）恰恰相反：**底色比星空更暗、几乎不加色**，
    // 颜色只留给边缘那一道亮线。方向反了，所以怎么调透明度都不像。
    ctx.save();
    traceLoops(ctx, loops);
    const cx = border.center ? border.center.x : loops[0][0].x;
    const cy = border.center ? border.center.y : loops[0][0].y;
    const rOuter = border.fadeRadius || 360;
    const tint = mixToward(border.color, [10, 14, 24], 0.66);   // 向深空色去饱和，只留一点点归属色
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rOuter);
    const base = isDark ? 1 : 0.5;
    g.addColorStop(0, toRgba(tint, Math.min(1, (0.36 + boost) * base)));
    g.addColorStop(0.85, toRgba(tint, Math.min(1, (0.40 + boost) * base)));
    g.addColorStop(1, toRgba(tint, Math.min(1, (0.24 + boost) * base)));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // ── 边界：**内亮线 + 中软带 + 外柔光**（群星是"厚软带"而不是一条细线）──
    const lineAlpha = (isEditing ? 0.95 : isHovered ? 0.9 : 0.78) + (lod < 0.4 ? -0.22 : 0);
    ctx.save();
    traceLoops(ctx, loops);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 外柔光：宽、低透明
    ctx.strokeStyle = toRgba(border.color, Math.max(0.04, lineAlpha * 0.16));
    ctx.lineWidth = (isEditing ? 16 : 11) * unit;
    ctx.stroke();
    // 中软带：半宽
    ctx.strokeStyle = toRgba(border.color, Math.max(0.08, lineAlpha * 0.42));
    ctx.lineWidth = (isEditing ? 6 : 4.2) * unit;
    ctx.stroke();
    // 内亮线：屏幕恒定细线
    ctx.strokeStyle = toRgba(mixToward(border.color, [255, 255, 255], 0.25), Math.max(0.15, lineAlpha));
    ctx.lineWidth = (isEditing ? 1.8 : 1.2) * unit;
    ctx.stroke();
    ctx.restore();

    // ── 星域名：无底框墨字（深底描边，亮字取势力色）──
    if (!drawLabels || labelAlpha <= 0.02) continue;
    // 名字要不要出现，按**色块在屏幕上的半径**判（不是按整幅图的 scale）：
    // 缩到全图时 scale≈0.36，旧口径 `lod>0.4` 会让整幅图一个星域名都没有（用户看到的是“四个无名色块”）。
    const pxRadius = (border.fadeRadius || 360) * (exportMode ? 1 : scale);
    if (exportMode ? false : pxRadius < 26) continue;
    // 字号：2026-11-02 先按群星调成 9~15，实测**太小**（用户："星域名号太小"）——
    // 群星是小字，但它的地图密度是我们的十几倍，字小也读得出；我们星域少，放大到 12~22 才立得住。
    const fontPx = exportMode ? 17 * uiScale : Math.max(12, Math.min(22, pxRadius / 4.6));
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
